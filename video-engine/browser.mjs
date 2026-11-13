import { spawn } from 'node:child_process';
import { readFile, mkdir, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const delay = ms => new Promise(r => setTimeout(r, ms));

export class CDP extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.seq = 0; this.pending = new Map();
    socket.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result || {});
      } else this.emit(m.method, m.params || {});
    });
    socket.addEventListener('close', event => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('视频窗口已关闭，请重新打开。')); }
      this.pending.clear(); this.emit('closed', { code: event.code, reason: event.reason });
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接专用播放窗口。')), { once: true });
    });
    return new CDP(socket);
  }
  call(method, params = {}, timeout = 20000) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('播放窗口未连接。'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`播放窗口响应超时（${method}）。`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

export class Browser {
  constructor(profile) { this.profile = profile; this.port = null; this.browser = null; this.starting = null; }
  async ensure() {
    if (this.browser?.socket.readyState === WebSocket.OPEN) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async connectExisting() {
    if(this.browser?.socket.readyState===WebSocket.OPEN)return;
    const [p, wsPath] = (await readFile(path.join(this.profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    if (!/^\d+$/.test(p) || !wsPath?.startsWith('/devtools/browser/')) throw new Error('invalid browser endpoint');
    this.port = Number(p);
    this.browser = await CDP.connect(`ws://127.0.0.1:${this.port}${wsPath}`);
  }
  async start() {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    const connect = () => this.connectExisting();
    try { await connect(); return; } catch {}
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try { await access(chrome); } catch { throw new Error('需要先安装 Google Chrome，再打开本工具。'); }
    await unlink(path.join(this.profile, 'DevToolsActivePort')).catch(() => {});
    this.child = spawn('/usr/bin/open', ['-g', '-n', '-a', '/Applications/Google Chrome.app', '--args',
      `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
      '--disable-session-crashed-bubble', '--new-window', 'about:blank'
    ], { stdio: 'ignore' });
    let launchError;
    this.child.once('error', e => { launchError = e; });
    for (let i = 0; i < 80; i++) {
      if (launchError) throw launchError;
      try { await connect(); return; } catch {}
      await delay(250);
    }
    throw new Error('Chrome 启动超时。请关闭本工具专用的播放窗口后再试。');
  }
  async newPage(url = 'about:blank') {
    await this.ensure();
    const { targetId } = await this.browser.call('Target.createTarget', { url: 'about:blank', background: true });
    const cdp = await CDP.connect(`ws://127.0.0.1:${this.port}/devtools/page/${targetId}`);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Network.enable', { maxTotalBufferSize: 16000000, maxResourceBufferSize: 6000000 });
    if (url !== 'about:blank') await cdp.call('Page.navigate', { url });
    return { cdp, targetId };
  }
  async show(targetId) {
    await this.ensure();
    await this.browser.call('Target.activateTarget', { targetId });
    spawn('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'], { stdio: 'ignore' });
  }
  async cookiesFor(platform) {
    // Anonymous direct downloads do not need to launch a browser.
    try { await this.connectExisting(); } catch { return []; }
    const { cookies } = await this.browser.call('Storage.getCookies');
    return cookies.filter(c => platform.domains.some(d => c.domain.replace(/^\./,'') === d || c.domain.endsWith('.'+d)));
  }
  async closePage(targetId) {
    try { await this.browser?.call('Target.closeTarget', { targetId }); } catch {}
  }
}
