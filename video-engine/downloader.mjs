import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, stat, link } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { unusedPath } from './core.mjs';
import { platformFor, platformVideoId } from './platforms.mjs';
import { discoverProxy } from './proxy-discovery.mjs';
const exec = promisify(execFile);

export async function networkProxy(setting = 'auto', platform) {
  if (!['youtube','twitter'].includes(platform)) return '';
  if (setting === 'direct') return '';
  if (setting && setting !== 'auto') {
    const u = new URL(setting);
    if (!['http:','https:','socks5:','socks5h:'].includes(u.protocol)) throw new Error('代理地址需使用 http:// 或 socks5://。');
    return u.href;
  }
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  if (env) return env;
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 });
    const get = key => stdout.match(new RegExp('\\b' + key + '\\s*:\\s*(\\S+)'))?.[1];
    if (get('HTTPEnable') === '1' && get('HTTPProxy') && get('HTTPPort')) return `http://${get('HTTPProxy')}:${get('HTTPPort')}`;
  } catch {}
  const discovered=await discoverProxy();
  if(discovered)return discovered;
  // Use an already running local proxy; never change system networking.
  for (const port of [7900,7897,7890,10809]) {
    const open = await new Promise(resolve => {
      const s = net.connect({ host: '127.0.0.1', port });
      const finish = v => { s.destroy(); resolve(v); };
      s.setTimeout(180); s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.once('timeout', () => finish(false));
    });
    if (open) return `http://127.0.0.1:${port}`;
  }
  return '';
}

export function cookieText(cookies) {
  return '# Netscape HTTP Cookie File\n' + cookies.filter(c => !/[\t\r\n]/.test([c.domain,c.path,c.name,c.value].join(''))).map(c =>
    [c.domain, c.domain.startsWith('.') ? 'TRUE':'FALSE', c.path || '/', c.secure ? 'TRUE':'FALSE', Math.max(0, Math.floor(c.expires || 0)), c.name, c.value].join('\t')).join('\n') + '\n';
}

// Subprocess lifetime is tied to abort/timeout, including ffmpeg descendants.
export function runTool(binary, args, { signal, onLine = () => {}, timeout = 1800000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore','pipe','pipe'], detached: true });
    let tail = '', failed, killTimer;
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000); killTimer.unref(); };
    const abort = () => { failed = signal.reason || new Error('已取消'); kill(); };
    const timer = setTimeout(() => { failed = new Error('下载超时，请重试。'); kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout,child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8'); stream.on('data', chunk => {
        tail = (tail + chunk).slice(-16000); pending += chunk;
        const lines = pending.split(/[\r\n]+/); pending = lines.pop();
        for (const line of lines) { try { onLine(line); } catch {} }
        if (pending.length > 2000000) pending = '';
      });
      stream.on('end', () => { if (pending) { try { onLine(pending); } catch {} } });
    }
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', e => { clean(); reject(e); });
    child.once('close', code => { clean(); failed ? reject(failed) : code === 0 ? resolve() : reject(new Error(tail.match(/ERROR:[^\r\n]+/g)?.at(-1) || tail.trim().slice(-700) || `下载引擎退出 (${code})`)); });
    if (signal?.aborted) abort();
  });
}

export async function downloadWithEngine({ root, outputDir, job, signal, proxy = '', cookies = [], probe, onProgress = () => {}, onPhase = () => {},onMetadata=()=>{} }) {
  const temp = await mkdtemp(path.join(outputDir, '.video-export-'));
  const vendor = path.join(root, 'native/vendor');
  let info;const started=Date.now(),timings={};let firstData;
  const progress=(bytes,total)=>{if(bytes>0 && !firstData){firstData=Date.now();timings.firstDataMs=firstData-started;onPhase('正在下载视频和声音…',{stage:'download'})}onProgress(bytes,total)};
  const onLine=line=>{
    if(line.startsWith('TITLE:'))try{onMetadata({title:JSON.parse(line.slice(6))})}catch{}
    const p = /^PROGRESS:(\d+):([^\s]+)/.exec(line);
    if (p) progress(Number(p[1]), Number(p[2]) || 0);
    if (/\[(Merger|VideoRemuxer|Fixup)/.test(line)){if(!timings.mergeStarted)timings.mergeStarted=Date.now();onPhase('正在合并音视频…',{stage:'merge'})}
  };
  try {
    const youtube=platformFor(job.url)?.id==='youtube',videoId=platformVideoId(job.url);
    const args = ['--ignore-config','--no-playlist','--playlist-items','1','--no-warnings','--newline','--no-colors','--progress','--no-quiet',
      '--socket-timeout','15','--retries','3','--fragment-retries','3','--concurrent-fragments',youtube?'8':'4','--http-chunk-size','10M','--abort-on-unavailable-fragments',
      '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location',vendor,
      '--match-filter', '!is_live & !is_upcoming', '--format','bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--merge-output-format','mp4','--remux-video','mp4','--write-info-json',
      '--output',path.join(temp,'source.%(ext)s'),
      '--progress-template','download:PROGRESS:%(progress.downloaded_bytes)s:%(info.filesize,progress.total_bytes,info.filesize_approx,progress.total_bytes_estimate)s',
      '--print','before_dl:TITLE:%(title)j',
      '--print','after_move:COMPLETE:%(filepath)s'];
    if (proxy) args.push('--proxy',proxy); else args.push('--proxy','');
    if(youtube)args.push('--extractor-args','youtube:formats=dashy');
    if (cookies.length) { const cookieFile = path.join(temp,'cookies.txt'); await writeFile(cookieFile,cookieText(cookies),{mode:0o600}); args.push('--cookies',cookieFile); }
    const url=youtube && videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : job.url;
    onPhase('正在解析视频链接…',{stage:'resolving'});
    await runTool(path.join(vendor,'yt-dlp'),[...args,'--',url],{signal,onLine});
    signal?.throwIfAborted();
    info = JSON.parse(await readFile(path.join(temp,'source.info.json'),'utf8'));
    if (info.is_live || info.is_upcoming || info.live_status === 'is_live') throw new Error('这条链接正在直播，请在直播结束后导出回放。');
    let source = path.join(temp,'source.mp4');
    if(timings.mergeStarted)timings.mergeMs=Date.now()-timings.mergeStarted;
    const validateStarted=Date.now();onPhase('正在检查视频完整性…',{stage:'validating'});
    let media = await probe(source);timings.validateMs=Date.now()-validateStarted;
    const expected = Number(info.duration || 0);
    if (expected > 2 && media.duration + Math.max(2,expected * 0.03) < expected) throw new Error('下载结果短于原视频，已丢弃不完整文件。');
    const hasAudio = info.acodec && info.acodec !== 'none' || info.requested_formats?.some(f => f.acodec && f.acodec !== 'none');
    if (hasAudio && !media.audioTracks) throw new Error('音轨未正确合并，已丢弃，请重试。');
    // Preserve original streams. AVFoundation validation prevents unplayable output being marked done.
    signal?.throwIfAborted();
    const title = info.title || job.title || '视频', id = info.id || job.videoId || job.id.slice(0,8);
    const file = await unusedPath(outputDir,`${title}_${id}`);
    const bytes = (await stat(source)).size;
    await link(source,file);
    timings.totalMs=Date.now()-started;
    if(firstData)timings.transferMs=(timings.mergeStarted||validateStarted)-firstData;
    delete timings.mergeStarted;
    const mode=/http_dash_segments/.test(info.protocol||'')?'native-dash-8':'native-http';
    return { file, bytes, media, title, author: info.uploader || info.channel || info.creator || '', videoId:id, duration:expected || media.duration, transport:`${mode}-${proxy?'proxy':'direct'}`, timings };
  } finally { await rm(temp,{recursive:true,force:true}); }
}
