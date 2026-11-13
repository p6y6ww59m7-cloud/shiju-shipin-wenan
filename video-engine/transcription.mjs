import path from 'node:path';
import { stat, access, readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { safeName } from './core.mjs';

export const MODEL_ID = 'large-v3';
export const MODEL_LABEL = 'Whisper large-v3 · FP16';
export const MODEL_NAME = 'ggml-large-v3.bin';
export const MODEL_BYTES = 3095033483;
export const VAD_NAME = 'ggml-silero-v6.2.0.bin';
export const VAD_BYTES = 885098;
export const busyTranscript = t => ['queued', 'extracting', 'recognizing', 'writing', 'cancelling'].includes(t?.status);
export function initialPrompt(job) {
  // The real work title provides spelling and punctuation context, not replacement narration.
  const topic = String(job.title || '').split('#')[0].replace(/\s+/g,' ').trim().slice(0,240);
  const author = String(job.author || '').replace(/\s+/g,' ').trim().slice(0,40);
  return (topic ? topic.replace(/[。！？.!?]+$/,'') + '。' : '') + (author ? `作者：${author}。` : '');
}

export function timestamp(ms, separator = ',') {
  ms = Math.max(0, Math.round(ms));
  const hh = Math.floor(ms / 3600000), mm = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
  return [hh,mm,ss].map(x => String(x).padStart(2,'0')).join(':') + separator + String(ms % 1000).padStart(3,'0');
}
export function normalizeResult(result) {
  if (!Array.isArray(result.transcription)) throw new Error('语音识别结果不完整，请重试。');
  const segments = result.transcription.map(s => ({ start: Number(s.offsets?.from), end: Number(s.offsets?.to),
    text: String(s.text || '').replace(/\[_[^\]]+\]/g, '').trim() }))
    .filter(s => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  if (!segments.length) throw new Error('没有识别到清晰的人声。请检查视频是否有口播。');
  let paragraph = '', paragraphs = [];
  for (let i=0;i<segments.length;i++) {
    const s=segments[i];
    const space = paragraph && (result.result?.language !== 'zh' || (/[A-Za-z0-9]$/.test(paragraph) && /^[A-Za-z0-9]/.test(s.text))) ? ' ' : '';
    paragraph += space + s.text;
    const gap = segments[i+1] ? segments[i+1].start - s.end : 0;
    if ((paragraph.length >= 120 && /[。！？.!?]$/.test(paragraph)) || paragraph.length >= 180 || (paragraph.length >= 50 && gap >= 700)) {
      paragraphs.push(paragraph); paragraph = '';
    }
  }
  if (paragraph) paragraphs.push(paragraph);
  const text = paragraphs.join('\n\n');
  const srt = segments.map((s,i) => `${i+1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${s.text}\n`).join('\n');
  return { language: result.result?.language || 'auto', text, segments, srt };
}

export async function writeTranscriptOutputs(file, normalized, metadata = {}, signal) {
  const suffix = metadata.model === MODEL_ID ? '.口播·高精度' : '.口播';
  const base = path.join(path.dirname(file), safeName(path.parse(file).name).slice(0,56) + suffix);
  let paths;
  for (let i=0;i<10000;i++) {
    const stem = base + (i ? ` (${i+1})` : '');
    paths = { txt: stem+'.txt', srt: stem+'.srt', json: stem+'.json' };
    const exists = await Promise.all(Object.values(paths).map(p => access(p).then(()=>true,()=>false)));
    if (!exists.some(Boolean)) break;
    paths = null;
  }
  if (!paths) throw new Error('同名文稿太多，请先整理保存目录。');
  const written = [];
  try {
    const doc = { ...metadata, language: normalized.language, text: normalized.text, segments: normalized.segments };
    for (const [p, content] of [[paths.txt, normalized.text+'\n'], [paths.srt, normalized.srt], [paths.json, JSON.stringify(doc,null,2)]]) {
      signal?.throwIfAborted();
      await writeFile(p, content, { flag: 'wx' }); written.push(p);
    }
    signal?.throwIfAborted(); return paths;
  } catch(e) { await Promise.all(written.map(p=>unlink(p).catch(()=>{}))); throw e; }
}

export class Transcriber {
  constructor({ root, dataDir, jobs, changed }) {
    this.root = root; this.dataDir = dataDir; this.jobs = jobs; this.changed = changed;
    this.model = path.join(dataDir, 'models', MODEL_NAME);
    this.vadModel = path.join(dataDir, 'models', VAD_NAME);
    this.binary = path.join(root, 'native/vendor/whisper-cli');
    this.audio = path.join(root, 'native/AudioPrepare');
    this.active = null; this.child = null; this.paused = false; this.stopped = false;
    this.engine = { ready: false, message: '正在检查口播识别资源…' };
  }
  async check() {
    try {
      await access(this.binary); await access(this.audio);
      let found = false;
      for (const candidate of [this.model, path.join(this.root,'native/vendor/models',MODEL_NAME)]) {
        try { if ((await stat(candidate)).size === MODEL_BYTES) { this.model = candidate; found = true; break; } } catch {}
      }
      if (!found) throw new Error('model');
      let vadFound = false;
      for (const candidate of [this.vadModel, path.join(this.root,'native/vendor/models',VAD_NAME)]) {
        try { if ((await stat(candidate)).size === VAD_BYTES) { this.vadModel = candidate; vadFound = true; break; } } catch {}
      }
      if (!vadFound) throw new Error('vad');
      this.engine = { ready: true, model: MODEL_ID, precision: 'FP16', message: `高精度识别已就绪 · ${MODEL_LABEL}` };
    } catch {
      this.engine = { ready: false, model: MODEL_ID, precision: 'FP16', message: '完整 large-v3 或人声检测资源未就绪，请完成高精度版安装。' };
    }
    return this.engine;
  }
  async enqueue(job) {
    if (!job.file || job.status !== 'done') throw new Error('请先把视频保存到本地，再转写口播。');
    if (busyTranscript(job.transcript) || (job.transcript?.status === 'done' && job.transcript.model === MODEL_ID)) return;
    if (!(await this.check()).ready) throw new Error(this.engine.message);
    if (busyTranscript(job.transcript) || (job.transcript?.status === 'done' && job.transcript.model === MODEL_ID)) return;
    if (job.media?.audioTracks === 0) throw new Error('这条视频没有音轨，无法转写口播。');
    const previous = job.transcript?.status === 'done' ? {
      model: job.transcript.model || 'large-v3-turbo-q5_0', files: job.transcript.files,
      charCount: job.transcript.charCount, completedAt: job.transcript.completedAt
    } : job.transcript?.previous;
    job.transcript = { status: 'queued', model: MODEL_ID, modelLabel: MODEL_LABEL,
      progress: 0, message: '等待高精度转写口播', queuedAt: Date.now(), ...(previous ? {previous} : {}) };
    await this.changed(); this.run();
  }
  setPaused(value) { this.paused = value; if (!value) this.run(); }
  async cancel(job) {
    if (!busyTranscript(job.transcript)) return;
    if (this.active === job) {
      job.transcript.status = 'cancelling'; job.transcript.message = '正在取消转写…';
      this.controller.abort(); this.child?.kill('SIGTERM');
      await this.running;
    } else {
      job.transcript.status = 'cancelled'; job.transcript.message = '已取消口播转写'; await this.changed();
    }
  }
  run() {
    if (this.active || this.paused || this.stopped) return;
    const job = this.jobs.find(j=>j.transcript?.status === 'queued');
    if (!job) return;
    this.active = job; this.controller = new AbortController();
    this.running = this.process(job, this.controller.signal).finally(()=>{
      this.active = null; this.child = null; this.controller = null;
      if (!this.stopped) setTimeout(()=>this.run(),200);
    });
  }
  execute(binary, args, { signal, input, onLine } = {}) {
    return new Promise((resolve,reject)=>{
      signal?.throwIfAborted();
      const child = spawn(binary, args, { stdio: ['pipe','pipe','pipe'], signal });
      this.child = child;
      let stdout = '', stderr = '', pending = '', settled = false;
      const finish = (error, result) => { if(settled)return; settled=true; this.child=null; error?reject(error):resolve(result); };
      child.stdout.on('data', c=>{ stdout += c; if(stdout.length>12000000)stdout=stdout.slice(-12000000); });
      child.stderr.on('data', c=>{
        stderr = (stderr+c).slice(-16000); pending += c;
        const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)onLine?.(line);
      });
      child.on('error', e=>finish(e));
      child.on('close', code=>{
        if(pending)onLine?.(pending);
        if(code===0)finish(null,{stdout,stderr});
        else {
          const detail = stderr.split('\n').map(s=>{try{return JSON.parse(s).error}catch{return null}}).find(Boolean);
          finish(new Error(detail || (signal?.aborted ? '已取消口播转写' : '口播识别未完成，请重试。')));
        }
      });
      child.stdin.on('error',()=>{}); child.stdin.end(input || '');
    });
  }
  async process(job, signal) {
    const t = job.transcript;
    Object.assign(t, { model: MODEL_ID, modelLabel: MODEL_LABEL, voiceDetection: 'Silero v6.2.0', startedAt: Date.now() });
    let temp, timeout;
    try {
      temp = await mkdtemp(path.join(os.tmpdir(), 'douyin-speech-'));
      timeout = setTimeout(()=>this.controller?.abort(new Error('转写超过 1 小时，请分段处理。')),3600000);
      t.status = 'extracting'; t.progress = 1; t.message = '正在读取视频中的声音…'; await this.changed();
      const wav = path.join(temp,'speech.wav');
      await this.execute(this.audio, [job.file,wav], { signal, onLine:line=>{
        try { const p=JSON.parse(line).progress;if(Number.isFinite(p))t.progress=Math.max(1,Math.round(p/10)); }catch{}
      }});
      signal.throwIfAborted();
      t.status = 'recognizing'; t.progress = 10; t.message = '正在用完整 large-v3 模型识别口播…'; await this.changed();
      const output = path.join(temp,'result');
      const prompt = initialPrompt(job);
      await this.execute(this.binary, ['--model',this.model,'--file',wav,'--language','auto',
        '--output-json','--output-file',output,'--print-progress','--threads','6',
        '--beam-size','5','--best-of','5',
        '--vad','--vad-model',this.vadModel,
        ...(prompt ? ['--prompt',prompt,'--carry-initial-prompt'] : [])],
      { signal, onLine:line=>{
        const m=/progress\s*=\s*(\d+)%/.exec(line);
        if(m){t.progress=Math.min(97,10+Math.round(Number(m[1])*.87));t.message=`正在高精度识别口播 ${m[1]}%`;}
      }});
      signal.throwIfAborted();
      let raw = await readFile(output+'.json','utf8');
      const parsed = JSON.parse(raw);
      if (parsed.result?.language === 'zh') {
        const simplified = await this.execute(this.audio,['--simplify'],{signal,input:raw}); raw=simplified.stdout;
      }
      const normalized = normalizeResult(JSON.parse(raw));
      t.status='writing';t.progress=98;t.message='正在保存文稿和字幕…';await this.changed();
      const paths = await writeTranscriptOutputs(job.file,normalized,{
        title:job.title,author:job.author,source:job.url,videoId:job.videoId,
        engine:'whisper.cpp v1.9.5 / large-v3 FP16 + Silero VAD', model: MODEL_ID, precision: 'FP16', voiceDetection: 'Silero v6.2.0', created:new Date().toISOString()
      },signal);
      Object.assign(t,{ status:'done',progress:100,message:`高精度口播已完成 · ${normalized.text.length} 字 · ${normalized.segments.length} 条字幕`,
        files:paths,language:normalized.language,charCount:normalized.text.length,segmentCount:normalized.segments.length,completedAt:Date.now() });
    } catch(e) {
      t.status = signal.aborted ? 'cancelled' : 'error';
      t.message = signal.aborted ? '已取消口播转写，可以重新开始' : e.message;
    } finally {
      clearTimeout(timeout); if(temp)await rm(temp,{recursive:true,force:true}).catch(()=>{});
      await this.changed().catch(()=>{});
    }
  }
  async shutdown() {
    this.stopped = true;
    if(this.active){this.controller?.abort();this.child?.kill('SIGTERM');await this.running;}
  }
}
