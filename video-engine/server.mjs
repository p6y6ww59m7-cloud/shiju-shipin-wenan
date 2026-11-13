import http from 'node:http';
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Browser } from './browser.mjs';
import { extractLinks, videoId, findVideoObjects, formatsFromObject, safeName, saveVideo, unusedPath } from './core.mjs';
import { Transcriber, busyTranscript } from './transcription.mjs';
import { platforms, platformFor, platformVideoId, playbackURL, kuaishouData } from './platforms.mjs';
import { downloadWithEngine, networkProxy } from './downloader.mjs';
import { downloadIssue, pageGate } from './workflow.mjs';
import { savedVideo,sourceKey } from './cache.mjs';
import { claimEngine } from './engine-session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = process.env.DOUYIN_EXPORT_RUNTIME || here;
const execFileAsync = promisify(execFile);
const dataDir = process.env.DOUYIN_EXPORT_DATA || path.join(os.homedir(), 'Library/Application Support/抖音视频导出助手');
const outputDir = process.env.DOUYIN_EXPORT_OUTPUT || path.join(os.homedir(), 'Downloads/抖音视频导出');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(outputDir, { recursive: true });
const engineSession=await claimEngine(dataDir);
if(engineSession.existing){process.stdout.write(JSON.stringify({url:engineSession.existing.url,pid:engineSession.existing.pid,reused:true})+'\n');process.exit(0)}
const historyPath = path.join(dataDir, 'history.json');
const settingsPath = path.join(dataDir, 'settings.json');
let settings = { proxy: 'auto' };
try { const s = JSON.parse(await readFile(settingsPath, 'utf8')); if(typeof s.proxy === 'string')settings.proxy = s.proxy; } catch {}
const browser = new Browser(path.join(dataDir, 'ChromeProfile'));
const token = crypto.randomBytes(32).toString('hex');
const jobs = [];
let active = null, paused = false, timer = null, origin, stopping = false;
let persistChain = Promise.resolve();

try {
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  for (const j of history) {
    const ended = ['done', 'cancelled', 'error', 'interrupted'].includes(j.status);
    const transcript = j.transcript && ['extracting','recognizing','writing','cancelling'].includes(j.transcript.status)
      ? { ...j.transcript, status: 'interrupted', message: '上次转写已中断，点击重试转写。' } : j.transcript;
    jobs.push({ ...j, status: ended ? j.status : 'interrupted', transcript,
      message: ended ? j.message : '上次任务已结束，可以重新尝试。', candidates: [] });
  }
} catch {}
const transcriber = new Transcriber({ root: runtimeRoot, dataDir, jobs, changed: persist });
await transcriber.check();

function publicJob(j) {
  return {
    id: j.id, url: j.url, platform: platformFor(j.url)?.id, platformLabel: platformFor(j.url)?.label, videoId: j.videoId, title: j.title, author: j.author, status: j.status,
    message: j.message, bytes: j.bytes || 0, total: j.total || 0, file: j.file, created: j.created,
    duration: j.duration, media: j.media, needsReview: j.needsReview, autoTranscribe: j.autoTranscribe,
    downloadStarted: j.downloadStarted, downloadFinished: j.downloadFinished,
    reusedAt: j.reusedAt,
    downloadStage: j.downloadStage, speed: j.speed || 0, eta: j.eta, transport: j.transport, timings: j.timings,
    access: j.access,
    transcript: j.transcript,
    candidates: (j.candidates || []).map((c, i) => ({ index: i, verified: c.verified, quality: c.quality,
      width: c.width, height: c.height, size: c.expectedSize, source: c.source }))
  };
}
function persist() {
  const snapshot = JSON.stringify(jobs.map(j => ({ ...publicJob(j), candidates: [] })), null, 2);
  persistChain = persistChain.catch(() => {}).then(async () => {
    const temp = historyPath + '.tmp';
    await writeFile(temp, snapshot, { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(temp, historyPath);
  });
  return persistChain;
}
function message(j, value) { j.message = value; }
function updateProgress(j,bytes,total) {
  const now=Date.now();
  if(!j.progressAt || bytes<j.progressBytes){j.progressAt=now;j.progressBytes=bytes;j.speed=0}
  else if(now-j.progressAt>=500){const rate=(bytes-j.progressBytes)*1000/(now-j.progressAt);j.speed=j.speed?j.speed*.4+rate*.6:rate;j.progressAt=now;j.progressBytes=bytes}
  j.bytes=bytes;j.total=total;j.eta=j.speed>0&&total>bytes?Math.ceil((total-bytes)/j.speed):null;
}
function addCandidate(j, c) {
  if (!/^https?:\/\//.test(c.url)) return;
  const existing = j.candidates.find(x => x.url === c.url);
  if (existing) { Object.assign(existing, c, { headers: { ...existing.headers, ...c.headers } }); return; }
  if (j.candidates.length < 24) j.candidates.push(c);
}
function applyData(j, data) {
  if (platformFor(j.url)?.id === 'kuaishou') {
    for (const c of kuaishouData(data,j.videoId)) { if(c.title)j.title=c.title; if(c.author)j.author=c.author; if(c.duration)j.duration=c.duration; addCandidate(j,c); }
    return;
  }
  for (const obj of findVideoObjects(data, j.videoId)) {
    j.title = obj.desc || j.title;
    j.author = obj.author?.nickname || '';
    j.duration = Number(obj.video?.duration || 0) / 1000;
    for (const c of formatsFromObject(obj)) addCandidate(j, c);
    if (!j.candidates.length && obj.images?.length) message(j, '这条链接是图文作品，当前版本只导出视频。');
  }
}

const domExpression = `(() => {
  const videos = [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 50);
  videos.sort((a,b) => Number(!a.paused) - Number(!b.paused) || a.getBoundingClientRect().width*a.getBoundingClientRect().height - b.getBoundingClientRect().width*b.getBoundingClientRect().height);
  const v = videos.at(-1);
  const visible = e => { const r=e.getBoundingClientRect();return r.width>0 && r.height>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none'; };
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog[open],[class*="login-modal"],[class*="loginModal"],[class*="captcha"],[class*="verify-modal"]')].filter(visible).map(e=>e.innerText?.slice(0,1500)||'');
  const password=[...document.querySelectorAll('input[type="password"]')].some(visible);
  const challenge=[...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"],[class*="captcha-container"],[class*="captcha_verify_container"]')].some(visible);
  const scripts = [...document.querySelectorAll('script#RENDER_DATA,script#__NEXT_DATA__,script[type="application/json"]')].map(s=>s.textContent).filter(s=>s.length<4000000).slice(0,10);
  const globals = [];
  for (const name of ['_ROUTER_DATA','__INITIAL_STATE__','__INIT_PROPS__','__APOLLO_STATE__','INIT_STATE','__INITIAL_DATA__']) {
    try { if (window[name]) { const s=JSON.stringify(window[name]); if(s.length<4000000)globals.push(s); } } catch {}
  }
  const react = [];
  if(v) {
    let el=v;
    for(let i=0;el && i<8;i++,el=el.parentElement){
      const key=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));
      let f=key && el[key];
      for(let n=0;f && n<10;n++,f=f.return){
        const p=f.memoizedProps;
        for(const k of ['aweme','awemeInfo','awemeDetail','videoInfo','item','data']) {
          try { const o=p?.[k]; if(o && (o.aweme_id||o.awemeId) && o.video)react.push(JSON.stringify(o)); }catch{}
        }
      }
    }
  }
  return {url:location.href,title:document.title,text:document.body?.innerText?.slice(0,6000)||'',scripts,globals,react,dialogs,password,challenge,
    video:v ? {src:v.currentSrc||v.src,duration:Number.isFinite(v.duration)?v.duration:0,width:v.videoWidth,height:v.videoHeight,paused:v.paused,readyState:v.readyState} : null};
})()`;

async function requestAccess(j, kind) {
  if(j.access?.kind===kind)return;
  j.access={kind};j.needsReview=false;
  const label=platformFor(j.url)?.label || '平台';
  message(j,kind==='verification'?`${label}要求安全验证，请在打开的窗口完成验证，完成后会自动继续。`:`${label}要求登录，请在打开的窗口登录，完成后会自动继续。`);
  try{j.cookieStamp=JSON.stringify(await browser.cookiesFor(platformFor(j.url)))}catch{}
  await persist();await browser.show(j.targetId);
}

async function retryEngine(j) {
  if(j!==active || j.cancelled)return;
  j.status='opening';j.access=null;
  await browser.closePage(j.targetId);j.cdp?.close();j.targetId=null;
  j.controller=new AbortController();
  j.transfer=engineDownload(j);
  try{await j.transfer}catch(e){if(!j.cancelled){j.status='error';message(j,e.message);await finish(j,false)}}finally{j.transfer=null}
}

async function attach(j) {
  const { cdp, targetId } = await browser.newPage();
  if (j.cancelled || active !== j) { cdp.close(); await browser.closePage(targetId); return; }
  j.cdp = cdp; j.targetId = targetId; j.requests = new Map(); j.responses = new Map(); j.data = [];
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    j.requests.set(requestId, { url: request.url, headers: request.headers });
    if (j.requests.size > 1500) j.requests.delete(j.requests.keys().next().value);
  });
  cdp.on('Network.responseReceived', ({ requestId, response, type }) => {
    const mime = (response.mimeType || '').toLowerCase();
    if (mime.startsWith('video/') && !/mp2t|mpegurl/.test(mime)) {
      const req = j.requests.get(requestId);
      const h = response.headers;
      const range = String(h['content-range'] || h['Content-Range'] || '');
      addCandidate(j, { url: response.url, mime, verified: false, source: '播放资源，需预览确认',
        quality: '播放画质', expectedSize: Number(range.split('/')[1] || h['content-length'] || h['Content-Length'] || 0),
        headers: req?.headers || {} });
    }
    if (/json/.test(mime) && /aweme|feed|detail|video|graphql|photo/i.test(response.url)) j.responses.set(requestId, response);
  });
  cdp.on('Network.loadingFinished', async ({ requestId, encodedDataLength }) => {
    if (!j.responses.has(requestId)) return;
    j.responses.delete(requestId);
    if (encodedDataLength > 6000000) return;
    try {
      const r = await cdp.call('Network.getResponseBody', { requestId });
      const text = r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body;
      const data = JSON.parse(text);
      if (j.data.length < 20) j.data.push(data);
      applyData(j, data);
    } catch {}
  });
  cdp.on('closed', info => {
    if (active === j && ['opening', 'waiting'].includes(j.status)) {
      process.stderr.write(`Playback connection closed: ${JSON.stringify(info)}\n`);
      j.status = 'error'; message(j, '播放窗口连接已断开。点“重试”重新打开。'); finish(j, false);
    }
  });
  await cdp.call('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement)e.target.muted=true},true);`});
  await cdp.call('Page.navigate', { url: playbackURL(j.url) });
  if (j.cancelled || active !== j) { cdp.close(); await browser.closePage(targetId); return; }
  j.status = 'waiting'; j.started = Date.now();
  message(j, '正在自动识别视频，无需操作…');
}

let polling = false;
async function poll() {
  if (polling || !active || active.status !== 'waiting') return;
  polling = true;
  const j = active;
  try {
    const { result } = await j.cdp.call('Runtime.evaluate', { expression: domExpression, returnByValue: true }, 8000);
    if (active !== j || j.status !== 'waiting' || !result?.value) return;
    const d = result.value;
    const id = platformVideoId(d.url);
    if (id && !j.videoId) j.videoId = id;
    for (const data of j.data) applyData(j, data);
    for (const raw of [...d.scripts, ...d.globals, ...d.react]) {
      try { applyData(j, JSON.parse(raw)); } catch { try { applyData(j, JSON.parse(decodeURIComponent(raw))); } catch {} }
    }
    if (d.title && !j.author && !/抖音 - 记录美好生活|验证码/.test(d.title)) j.title = d.title.replace(/\s*[-_]\s*(抖音|快手).*$/, '');
    const v = d.video;
    const enginePlatform=['youtube','bilibili','twitter'].includes(platformFor(j.url)?.id);
    // Direct DOM sources are tied to the requested work, unlike prefetched network videos.
    if (v && /^https?:\/\//.test(v.src) && id && id === j.videoId) {
      addCandidate(j, { url: v.src, verified: true, source: '当前视频播放器', quality: '播放画质',
        width: v.width, height: v.height, score: 0 });
      if (!j.duration) j.duration = v.duration;
    }
    const verified = j.candidates.filter(c => c.verified).sort((a,b) => (b.score || 0)-(a.score || 0));
    if (verified.length && !j.cancelled && !enginePlatform) {
      j.access=null;
      await download(j, verified); return;
    }
    const elapsed = Date.now() - j.started;
    const gate=pageGate(d);
    if(enginePlatform && j.access) {
      const cookies=JSON.stringify(await browser.cookiesFor(platformFor(j.url)));
      if((!gate && v?.readyState>=2) || (cookies!==j.cookieStamp && !gate && elapsed>2500)) {await retryEngine(j);return}
    }
    if(gate) {await requestAccess(j,gate);return}
    if(j.access && !enginePlatform)j.access=null;
    if(enginePlatform && v?.readyState>=2 && (j.engineAttempts||0)<2 && elapsed>4000){await retryEngine(j);return}
    if (/作品不存在|视频不见了|作品已删除|该视频不可用|this video is unavailable/i.test(d.text)) {
      j.status='error';message(j,'平台提示该视频已删除或不可用。');await finish(j,true);return;
    }
    // Trigger playback inside the dedicated task page; no unrelated media is clicked.
    if(v?.paused && v.src && elapsed>2500) {
      await j.cdp.call('Runtime.evaluate',{expression:`(()=>{const v=[...document.querySelectorAll('video')].find(v=>v.getBoundingClientRect().width>50);if(v){v.muted=true;v.play().catch(()=>{})}})()`}).catch(()=>{});
    }
    if(elapsed>15000)message(j,'正在自动识别当前作品和完整视频资源…');
    if (elapsed > 90000) {
      j.status = 'error'; message(j, '暂时无法取得这条作品的完整视频，请稍后重试。'); finish(j, true);
    }
  } catch (e) {
    if ((Date.now() - j.started > 25000 && !j.cdp?.socket) || j.cdp?.socket.readyState === WebSocket.CLOSED) {
      j.status = 'error'; message(j, '播放窗口已断开，请重试。'); finish(j, false);
    }
  } finally { polling = false; }
}

function playbackHeaders(c, referer) {
  const out = { referer: referer || 'https://www.douyin.com/', 'accept-encoding': 'identity' };
  for (const [k,v] of Object.entries(c.headers || {})) {
    if (/^(user-agent|referer|origin|accept|accept-language)$/i.test(k)) out[k.toLowerCase()] = v;
  }
  return out;
}
async function resourceResponse(j, c, signal) {
  // Request cookies only for this video's URL in the tool's dedicated browser session.
  const headers = playbackHeaders(c, j.url);
  try {
    const { cookies } = await j.cdp.call('Network.getCookies', { urls: [c.url] });
    if (cookies.length) headers.cookie = cookies.map(x => `${x.name}=${x.value}`).join('; ');
    const { result } = await j.cdp.call('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
    if (result.value) headers['user-agent'] = result.value;
  } catch {}
  return fetch(c.url, { headers, signal });
}

async function probe(file) {
  const binary = path.join(runtimeRoot, 'native/VideoProbe');
  await access(binary);
  const { stdout } = await execFileAsync(binary, [file], { timeout: 30000 });
  const media = JSON.parse(stdout);
  if (!(media.duration > 0) || !media.videoTracks) throw new Error('文件未通过可播放性检查，请重新识别视频。');
  return media;
}

function download(j, candidates) {
  if (j.transfer) return j.transfer;
  const transfer = downloadFile(j, candidates);
  j.transfer = transfer;
  return transfer.finally(() => { if (j.transfer === transfer) j.transfer = null; });
}
async function downloadFile(j, candidates) {
  if (j.downloading || j.cancelled || active !== j) return;
  j.downloading = true; j.status = 'downloading'; j.downloadStage='download';j.needsReview = false;
  const controller = new AbortController();
  j.controller = controller;
  message(j, '正在保存完整视频，原有音轨一并保留…');
  let error;
  for (const c of candidates) {
    if (j.cancelled) break;
    let p;
    try {
      const ext = c.mime?.includes('webm') ? 'webm' : 'mp4';
      p = await unusedPath(outputDir, `${j.title || '抖音视频'}_${j.videoId || j.id.slice(0,8)}`, ext);
      const timeout = setTimeout(() => controller.abort(new Error('下载超过 10 分钟，请重试。')), 600000);
      try {
        const response = await resourceResponse(j, c, controller.signal);
        const saved = await saveVideo(response, p, { signal: controller.signal,
          onProgress(bytes, total) { updateProgress(j,bytes,total); },
          validate: async file => {
            j.downloadStage='validating';message(j,'正在检查视频完整性…');
            j.media = await probe(file);
            if (j.duration > 1 && j.media.duration + Math.max(1.5, j.duration * 0.03) < j.duration)
              throw new Error('导出视频短于播放页标注的时长，未保存，请重新识别。');
          }
        });
        j.bytes = saved.bytes; j.total = saved.bytes;
      } finally { clearTimeout(timeout); }
      j.file = p; j.status = 'done'; j.downloadFinished = Date.now();j.downloadStage='done';j.speed=0;j.eta=null;
      message(j, `已保存 · ${j.media.duration.toFixed(1)} 秒 · ${j.media.width} × ${j.media.height}${j.media.audioTracks ? ' · 含声音' : ' · 源文件无音轨'}`);
      await writeFile(`${p}.来源.txt`, `来源：${j.url}\n作品：${j.videoId || ''}\n标题：${j.title || ''}\n作者：${j.author || ''}\n保存时间：${new Date().toISOString()}\n时长：${j.media.duration} 秒\n直接保存播放资源，未转码。\n`, 'utf8').catch(() => {});
      if (j.autoTranscribe) {
        try { await transcriber.enqueue(j); }
        catch (e) { j.transcript = { status: 'error', progress: 0, message: e.message }; }
      }
      await finish(j, true); return;
    } catch (e) { error = e; }
    if (controller.signal.aborted) break;
  }
  j.downloading = false;
  if (j.cancelled) return;
  j.status = 'error';
  message(j, error?.name === 'AbortError' ? '已取消或下载超时，请重试。' : error?.message || '未能保存视频，请刷新播放页后重试。');
  await finish(j, false);
}

async function finish(j, close) {
  if (active !== j) return;
  active = null;
  if (close) { await browser.closePage(j.targetId); j.cdp?.close(); }
  else j.cdp?.close();
  j.data = []; j.requests?.clear(); j.responses?.clear();
  j.candidates = []; j.controller = null; j.downloading = false;
  j.access=null;j.cookieStamp=null;
  await persist().catch(() => {});
  if (!stopping) setTimeout(runQueue, 500);
}
async function runQueue() {
  if (active || paused || stopping) return;
  const j = jobs.find(x => x.status === 'queued');
  if (!j) return;
  active = j; j.status = 'opening'; j.downloadStage='resolving';j.downloadStarted=Date.now(); message(j, '正在自动获取视频…');
  try {
    if (['douyin','kuaishou'].includes(platformFor(j.url)?.id)) await attach(j);
    else {
      j.controller = new AbortController();
      j.transfer = engineDownload(j);
      try { await j.transfer; } finally { j.transfer = null; }
    }
  } catch (e) { if(j.cancelled)return; j.status = 'error'; message(j, e.message); await finish(j, false); }
}

async function engineDownload(j) {
  j.engineAttempts=(j.engineAttempts||0)+1;
  const platform = platformFor(j.url);
  const proxy = await networkProxy(settings.proxy,platform.id);
  let cookies = []; try { cookies = await browser.cookiesFor(platform); } catch {}
  try {
    const result = await downloadWithEngine({ root:runtimeRoot,outputDir,job:j,signal:j.controller.signal,proxy,cookies,probe,
      onMetadata(info){if(info.title){j.title=info.title;persist().catch(()=>{})}},
      onProgress(bytes,total) { if(!j.cancelled){j.status='downloading';updateProgress(j,bytes,total);} },
      onPhase(text,details) { message(j,text);if(details?.stage)j.downloadStage=details.stage;persist().catch(()=>{}); } });
    Object.assign(j,result,{status:'done',downloadStage:'done',speed:0,eta:null,total:result.bytes,downloadFinished:Date.now()});
    message(j, `已保存 · ${j.media.duration.toFixed(1)} 秒 · ${j.media.width} × ${j.media.height}${j.media.audioTracks ? ' · 含声音' : ' · 源文件无音轨'}`);
    await writeFile(j.file+'.来源.txt',`来源：${j.url}\n平台：${platform.label}\n标题：${j.title}\n作者：${j.author}\n保存时间：${new Date().toISOString()}\n音视频由本机下载引擎保存与合并。\n`,'utf8').catch(()=>{});
    if(j.autoTranscribe)try{await transcriber.enqueue(j)}catch(e){j.transcript={status:'error',message:e.message,progress:0}}
    await finish(j,true);
  } catch(e) {
    if(j.cancelled || j.controller?.signal.aborted)throw e;
    process.stderr.write(`Download engine (${platform.id}): ${String(e.message).slice(-1200)}\n`);
    const issue=downloadIssue(e);
    if(issue==='unavailable'||issue==='network'||j.engineAttempts>2){j.status='error';message(j,issue==='unavailable'?'平台提示该视频不可用，或当前账号没有访问权限。':issue==='network'?'无法连接视频平台，请检查网络后重试。':'暂时未能下载完整视频，请稍后重试。');await finish(j,true);return}
    j.controller = null;
    await attach(j);
    if(active===j && ['login','verification'].includes(issue))await requestAccess(j,issue);
  }
}

const server = http.createServer(async (req,res) => {
  const respond = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return respond(403, { error: 'Host rejected' });
    if (req.headers.origin && req.headers.origin !== origin) return respond(403, { error: 'Origin rejected' });
    if (u.pathname === '/' && req.method === 'GET') {
      const html = (await readFile(path.join(here, 'public/index.html'), 'utf8')).replace('__SESSION_TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      return res.end(html);
    }
    if (u.pathname === '/health') return respond(200, { ok: true, app: 'douyin-local-exporter' });
    if (req.method==='GET' && ['/intake.mjs','/platforms.mjs'].includes(u.pathname)) {
      const file=u.pathname==='/intake.mjs'?path.join(here,'public/intake.mjs'):path.join(here,'platforms.mjs');
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});return res.end(await readFile(file));
    }
    if (req.headers['x-session-token'] !== token && !(u.pathname.startsWith('/api/preview/') && u.searchParams.get('token') === token)) return respond(403, { error: '会话已失效，请重新打开应用。' });
    if (u.pathname === '/api/state' && req.method === 'GET') return respond(200, { jobs: jobs.map(publicJob), paused, outputDir, settings, platforms, engine: transcriber.engine, activeId: active?.id || null });
    if (u.pathname === '/api/transcript' && req.method === 'GET') {
      const j = jobs.find(x => x.id === u.searchParams.get('id'));
      if (j?.transcript?.status !== 'done' || !j.transcript.files?.json) return respond(404, { error: '文稿还没有完成。' });
      try { return respond(200, JSON.parse(await readFile(j.transcript.files.json, 'utf8'))); }
      catch { return respond(404, { error: '找不到文稿文件，可能已被移动或删除。' }); }
    }
    if (u.pathname.startsWith('/api/preview/') && req.method === 'GET') {
      const [, , , id, index] = u.pathname.split('/');
      const j = jobs.find(x => x.id === id), c = j?.candidates[Number(index)];
      if (!c || active !== j) return respond(404, { error: '播放资源已过期，请重新识别。' });
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const response = await resourceResponse(j, c, controller.signal);
      if (!response.ok) return respond(502, { error: '预览暂不可用，请在抖音播放窗口确认。' });
      const headers = { 'Content-Type': response.headers.get('content-type') || 'video/mp4', 'Cache-Control': 'no-store' };
      if (response.headers.get('content-length')) headers['Content-Length'] = response.headers.get('content-length');
      res.writeHead(response.status, headers);
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res); return;
    }
    if (req.method !== 'POST') return respond(404, { error: 'Not found' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return respond(415, { error: '请求格式错误。' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 100000) return respond(413, { error: '一次粘贴的内容过多，请分批处理。' }); }
    const body = JSON.parse(raw || '{}');
    if (u.pathname === '/api/jobs') {
      const urls = extractLinks(body.text);
      if (!urls.length) return respond(400, { error: '没有找到支持的视频链接。支持抖音、YouTube、B站、快手、X / Twitter，可粘贴完整分享文字。' });
      if (urls.length > 30) return respond(400, { error: '每批最多 30 条链接，请分批添加。' });
      let added = 0,reused=0;const submitted=[];
      for (const url of urls) {
        const running=jobs.find(j => sourceKey(j.url) === sourceKey(url) && !['done','error','cancelled','interrupted'].includes(j.status));
        if(running){submitted.push(running.id);continue}
        const existing=body.force===true?null:await savedVideo(jobs,url,probe);
        if(existing){existing.reusedAt=Date.now();jobs.splice(jobs.indexOf(existing),1);jobs.push(existing);reused++;submitted.push(existing.id);continue}
        jobs.push({ id: crypto.randomUUID(), url, videoId: platformVideoId(url), title: '正在识别视频', status: 'queued',
          created: Date.now(), message: '等待处理', candidates: [], autoTranscribe: false }); added++;
        submitted.push(jobs.at(-1).id);
      }
      await persist(); respond(200, { added,reused,jobIds:submitted }); runQueue(); return;
    }
    if (u.pathname === '/api/browser') {
      if (active?.targetId && (!body.platform || body.platform===platformFor(active.url)?.id)) await browser.show(active.targetId);
      else { const platform=platforms.find(p=>p.id===body.platform)||platforms[0]; const p = await browser.newPage(platform.home); await browser.show(p.targetId); p.cdp.close(); }
      return respond(200, { ok: true });
    }
    if (u.pathname === '/api/folder') { spawn('/usr/bin/open', [outputDir], { stdio: 'ignore' }); return respond(200, { ok: true }); }
    if (u.pathname === '/api/settings') {
      if(typeof body.proxy==='string') {
        if(!['auto','direct'].includes(body.proxy)) { try{const u=new URL(body.proxy);if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol))throw 0;}catch{return respond(400,{error:'代理地址格式无效，请填 auto、direct 或 http://127.0.0.1:端口。'})} }
        settings.proxy=body.proxy;
      }
      await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/pause') { paused = Boolean(body.paused); transcriber.setPaused(paused); respond(200, { ok: true }); if (!paused) runQueue(); return; }
    if (u.pathname === '/api/clear') {
      for (let i=jobs.length-1;i>=0;i--) if (['done','error','cancelled','interrupted'].includes(jobs[i].status) && !busyTranscript(jobs[i].transcript)) jobs.splice(i,1);
      await persist(); return respond(200, { ok: true });
    }
    const j = jobs.find(x => x.id === body.id);
    if (!j) return respond(404, { error: '找不到这条任务。' });
    if (u.pathname === '/api/access') {
      if(j!==active || !j.access || j.status!=='waiting')return respond(409,{error:'当前任务不需要登录或验证。'});
      await browser.show(j.targetId);return respond(200,{ok:true});
    }
    if (u.pathname === '/api/transcription-choice') {
      if(typeof body.enabled!=='boolean')return respond(400,{error:'请选择是否转文字。'});
      j.autoTranscribe=body.enabled;
      if(body.enabled && j.status==='done' && j.transcript?.status!=='done') {
        try{await transcriber.enqueue(j)}catch(e){j.transcript={status:'error',message:e.message,progress:0}}
      }
      if(!body.enabled && busyTranscript(j.transcript))await transcriber.cancel(j);
      await persist();return respond(200,{ok:true});
    }
    if (u.pathname === '/api/login-retry') {
      if(active!==j || j.status!=='waiting' || ['douyin','kuaishou'].includes(platformFor(j.url)?.id))return respond(409,{error:'当前任务无需此操作。'});
      j.status='queued'; j.cdp?.close(); await browser.closePage(j.targetId); j.targetId=null; active=null;
      respond(200,{ok:true}); runQueue(); return;
    }
    if (u.pathname === '/api/transcribe') {
      await transcriber.enqueue(j); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/cancel-transcription') {
      await transcriber.cancel(j); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/open-transcript') {
      const format = body.format === 'srt' ? 'srt' : 'txt';
      const file = j.transcript?.files?.[format];
      if (!file || j.transcript.status !== 'done') return respond(404, { error: '文稿尚未完成。' });
      try { await access(file); } catch { return respond(404, { error: '文件已被移动或删除。' }); }
      spawn('/usr/bin/open', [file], { stdio: 'ignore' }); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/reveal' && j.file) {
      spawn('/usr/bin/open', ['-R', j.file], { stdio: 'ignore' }); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/cancel') {
      if (!['queued','opening','waiting','downloading'].includes(j.status)) return respond(409, { error: '这条任务已经结束。' });
      j.cancelled = true; j.controller?.abort();
      if (j.transfer) { j.status = 'cancelling'; message(j, '正在取消保存…'); await j.transfer.catch(() => {}); }
      j.status = 'cancelled'; message(j, '已跳过');
      await finish(j, true); await persist(); return respond(200, { ok: true });
    }
    if (u.pathname === '/api/retry') {
      if (!['error','cancelled','interrupted'].includes(j.status)) return respond(409, { error: '这条视频正在处理中。' });
      Object.assign(j, { status: 'queued', cancelled: false, downloading: false, candidates: [], access:null, engineAttempts:0, bytes: 0, total: 0,speed:0,eta:null,progressAt:0,progressBytes:0,downloadStage:null, message: '等待重试' });
      respond(200, { ok: true }); runQueue(); return;
    }
    if (u.pathname === '/api/save') {
      const c = j.candidates[Number(body.index)];
      if (j !== active || !c || j.status !== 'waiting') return respond(409, { error: '资源已失效，请重新识别。' });
      respond(200, { ok: true }); download(j, [c]); return;
    }
    return respond(404, { error: '操作不存在。' });
  } catch (e) {
    if (!res.headersSent) respond(500, { error: e.name === 'AbortError' ? '请求已结束。' : e.message });
    else res.destroy();
  }
});

server.listen(Number(process.env.PORT || 0), '127.0.0.1', async () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  await engineSession.publish(origin,token);
  process.stdout.write(`${JSON.stringify({ url: origin, pid: process.pid })}\n`);
  timer = setInterval(poll, 1500);
  transcriber.run();
});

async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer);
  if (active) { active.controller?.abort(); active.cdp?.close(); }
  await transcriber.shutdown();
  await persist().catch(() => {});
  await engineSession.release();
  browser.browser?.close();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
