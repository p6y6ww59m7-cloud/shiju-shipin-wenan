import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeResult, timestamp, writeTranscriptOutputs, Transcriber, initialPrompt, MODEL_ID, MODEL_NAME, MODEL_BYTES, VAD_NAME, VAD_BYTES } from '../transcription.mjs';

const raw = {result:{language:'zh'},transcription:[
  {offsets:{from:0,to:1250},text:' 这是一段测试字幕。 '},
  {offsets:{from:1250,to:3500},text:'从人物甲到人物乙·示例。'},
  {offsets:{from:3500,to:4000},text:''}
]};
async function temp(fn) {const d=await mkdtemp(path.join(os.tmpdir(),'douyin-text-test-'));try{return await fn(d)}finally{await rm(d,{recursive:true,force:true})}}

test('plain Chinese text retains spoken content and millisecond-aligned subtitles',()=>{
  const n=normalizeResult(raw);
  assert.equal(n.text,'这是一段测试字幕。从人物甲到人物乙·示例。');
  assert.equal(n.segments.length,2);
  assert.equal(n.srt,'1\n00:00:00,000 --> 00:00:01,250\n这是一段测试字幕。\n\n2\n00:00:01,250 --> 00:00:03,500\n从人物甲到人物乙·示例。\n');
  assert.equal(timestamp(3661001),'01:01:01,001');
});
test('English sentence boundaries retain spaces',()=>{
  const n=normalizeResult({result:{language:'en'},transcription:[{offsets:{from:0,to:1000},text:'Hello.'},{offsets:{from:1000,to:2000},text:'Welcome back.'}]});
  assert.equal(n.text,'Hello. Welcome back.');
});
test('empty and malformed speech results are failures rather than empty successful documents',()=>{
  assert.throws(()=>normalizeResult({}),/不完整/);
  assert.throws(()=>normalizeResult({transcription:[{offsets:{from:0,to:0},text:'noise'}]}),/没有识别/);
});
test('TXT, SRT and JSON contain the same text; retries never overwrite existing documents',()=>temp(async dir=>{
  const result=normalizeResult(raw), first=await writeTranscriptOutputs(path.join(dir,'视频.mp4'),result,{source:'https://v.douyin.com/example/'});
  const second=await writeTranscriptOutputs(path.join(dir,'视频.mp4'),result);
  assert.notEqual(first.txt,second.txt);
  assert.equal((await readFile(first.txt,'utf8')).trim(),result.text);
  assert.equal(await readFile(first.srt,'utf8'),result.srt);
  assert.equal(JSON.parse(await readFile(first.json,'utf8')).text,result.text);
  assert.equal((await readdir(dir)).length,6);
}));
test('cancelled publication leaves no partial transcript files',()=>temp(async dir=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(writeTranscriptOutputs(path.join(dir,'视频.mp4'),normalizeResult(raw),{},controller.signal));
  assert.deepEqual(await readdir(dir),[]);
}));
test('transcription cannot queue missing downloads and jobs without audio',async()=>{
  const t=new Transcriber({root:'/no-app',dataDir:'/no-model',jobs:[],changed:async()=>{}});
  await assert.rejects(t.enqueue({status:'error'}),/先把视频保存/);
  t.check=async()=>({ready:true});
  await assert.rejects(t.enqueue({status:'done',file:'/test.mp4',media:{audioTracks:0}}),/没有音轨/);
});
test('pausing and cancelling a queued transcription keeps its saved video intact',async()=>{
  const j={status:'done',file:'/test.mp4',transcript:{status:'queued'}};
  const t=new Transcriber({root:'/app',dataDir:'/data',jobs:[j],changed:async()=>{}});
  t.setPaused(true);t.run();assert.equal(t.active,null);
  await t.cancel(j);assert.equal(j.transcript.status,'cancelled');assert.equal(j.status,'done');assert.equal(j.file,'/test.mp4');
});
test('simultaneous requests queue the same saved video only once',async()=>{
  const j={id:'same-video',status:'done',file:'/test.mp4',media:{audioTracks:1}};let changes=0;
  const t=new Transcriber({root:'/app',dataDir:'/data',jobs:[j],changed:async()=>{changes++}});
  t.paused=true;t.check=async()=>{await Promise.resolve();return {ready:true}};
  await Promise.all([t.enqueue(j),t.enqueue(j)]);
  assert.equal(changes,1);assert.equal(j.transcript.status,'queued');
});
test('metadata provides spelling context while long unpunctuated speech still has readable paragraphs',()=>{
  assert.equal(initialPrompt({title:'测试：人物甲与人物乙·示例 #字幕 #测试'}),'测试：人物甲与人物乙·示例。');
  const pieces=Array.from({length:20},(_,i)=>({offsets:{from:i*1000,to:(i+1)*1000},text:'测试字幕需要保持完整内容'}));
  const n=normalizeResult({result:{language:'zh'},transcription:pieces});
  assert.ok(n.text.includes('\n\n'));
  assert.equal(n.text.replaceAll('\n\n',''),pieces.map(p=>p.text).join(''));
});
test('quality mode refuses a Turbo Q5 model and selects only the full large-v3 file',()=>temp(async dir=>{
  const native=path.join(dir,'native'),models=path.join(dir,'models');
  await mkdir(path.join(native,'vendor'),{recursive:true});await mkdir(models);
  await writeFile(path.join(native,'vendor/whisper-cli'),'');await writeFile(path.join(native,'AudioPrepare'),'');
  const legacy=path.join(models,'ggml-large-v3-turbo-q5_0.bin');await writeFile(legacy,'');await truncate(legacy,574041195);
  const t=new Transcriber({root:dir,dataDir:dir,jobs:[],changed:async()=>{}});
  assert.equal((await t.check()).ready,false);
  const full=path.join(models,MODEL_NAME);await writeFile(full,'');await truncate(full,MODEL_BYTES);
  assert.equal((await t.check()).ready,false);
  const vad=path.join(models,VAD_NAME);await writeFile(vad,'');await truncate(vad,VAD_BYTES);
  assert.equal((await t.check()).ready,true);assert.equal(t.engine.model,'large-v3');assert.equal(t.engine.precision,'FP16');assert.equal(t.model,full);
}));
test('upgrading an existing transcript retains its old files and records the actual model',async()=>{
  const files={txt:'/old.txt',srt:'/old.srt',json:'/old.json'};
  const j={id:'upgrade',status:'done',file:'/video.mp4',media:{audioTracks:1},transcript:{status:'done',files,charCount:300}};
  const t=new Transcriber({root:'/app',dataDir:'/data',jobs:[j],changed:async()=>{}});
  t.paused=true;t.check=async()=>({ready:true});await t.enqueue(j);
  assert.equal(j.transcript.model,MODEL_ID);assert.equal(j.transcript.status,'queued');assert.deepEqual(j.transcript.previous.files,files);
  assert.equal(j.transcript.previous.model,'large-v3-turbo-q5_0');
});
