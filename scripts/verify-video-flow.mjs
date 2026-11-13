// Optional real-network acceptance run. All application data and media use an isolated directory.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {Feishu} from '../lib/feishu.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=path.join(root,'.build-tools','real-video-flow-'+Date.now()),data=path.join(dir,'data');
await mkdir(data,{recursive:true});
await writeFile(path.join(data,'state.json'),JSON.stringify({schemaVersion:2,revision:0,topics:[],archives:[],trash:[]}));
const withFeishu=process.argv.includes('--feishu'),port=process.env.VERIFY_PORT||'43941',origin='http://127.0.0.1:'+port;
const offline=path.join(dir,'offline-lark');await writeFile(offline,'#!/bin/sh\nprintf \'{"identities":{"user":{"available":false}}}\\n\'\n',{mode:0o700});
if(withFeishu)await copyFile(path.join(root,'data/feishu.json'),path.join(data,'feishu.json'));
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,PORT:port,SHIJU_DATA_DIR:data,SHIJU_VIDEO_DATA_DIR:path.join(dir,'engine-data'),DOUYIN_EXPORT_OUTPUT:path.join(dir,'downloads'),LARK_CLI:withFeishu?(process.env.LARK_CLI||path.join(process.env.HOME,'.local/bin/lark-cli')):offline,CODEX_CLI:process.env.CODEX_CLI||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',c=>{stderr=(stderr+c).slice(-12000)});child.stdout.on('data',()=>{});
let token,topicId,report={directory:dir,started:new Date().toISOString(),withFeishu};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,body){const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-shiju-token':token},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(JSON.stringify(value));return value}
async function wait(label,fn,limit=1200){let last='';for(let i=0;i<limit;i++){const result=await fn();if(result.done)return result.value;if(i%15===0&&result.message!==last){last=result.message;console.log(JSON.stringify({stage:label,message:last}))}await delay(1000)}throw new Error('timeout: '+label)}
try{
  await wait('startup',async()=>{try{const s=await api('/api/state');token=s.token;return {done:true}}catch{return {message:'starting'}}},30);
  ({topicId}=await api('/api/action',{type:'topic.create',payload:{title:'融合流程验收 · 三平台视频',audience:'短视频创作者',purpose:'检查视频下载、口播转写、文案挑选、组稿定稿与飞书同步的完整流程'}}));
  report.topicId=topicId;
  const added=await api('/api/media/intake',{topicId,text:'https://www.youtube.com/watch?v=jNQXAC9IVRw\nhttps://www.bilibili.com/video/BV13x41117TL\nhttps://www.kuaishou.com/short-video/3x9kd95fjefs3nu'});assert.equal(added.added,3);
  let media=await api('/api/media/state');assert.equal(media.assets.length,3);assert.ok(media.assets.every(a=>!a.autoTranscribe));
  const selected=media.assets.find(a=>a.platform==='youtube');await api('/api/media/control',{id:selected.id,command:'transcription-choice',payload:{enabled:true}});
  media=await wait('download-and-transcribe',async()=>{
    const m=await api('/api/media/state');
    const failed=m.assets.find(a=>a.status==='error'||a.transcriptStatus?.status==='error');if(failed)throw new Error(JSON.stringify(failed));
    return {done:m.assets.length===3&&m.assets.every(a=>a.status==='done')&&m.assets.find(a=>a.id===selected.id).transcriptId,value:m,message:m.assets.map(a=>`${a.platform}:${a.status}:${a.transcriptStatus?.status||'no-transcription'}`).join(' / ')};
  });
  assert.equal(media.assets.filter(a=>a.transcriptId).length,1);assert.equal(media.assets.filter(a=>a.autoTranscribe).length,1);
  let state=await wait('automatic-import',async()=>{const s=await api('/api/state');return {done:s.topics.find(t=>t.id===topicId).documents.length===1,value:s,message:'waiting for document'}});
  const topic=()=>state.topics.find(t=>t.id===topicId);let doc=topic().documents[0];assert.equal(doc.media.assetId,selected.id);
  const original=await api('/api/media/transcript?id='+selected.id);assert.equal(original.model,'large-v3');assert.equal(original.precision,'FP16');assert.ok(original.segments.length);
  const raw=await fetch(origin+'/api/media/file?id='+selected.id,{headers:{range:'bytes=0-127'}});assert.equal(raw.status,206);assert.equal((await raw.arrayBuffer()).byteLength,128);
  const txt=await fetch(origin+'/api/media/transcript-file?id='+selected.id+'&format=txt');assert.equal((await txt.text()).trim(),original.text.trim());
  const srt=await fetch(origin+'/api/media/transcript-file?id='+selected.id+'&format=srt');assert.match(await srt.text(),/00:00:\d\d,\d{3} --> /);
  const repeated=await api('/api/media/intake',{topicId,text:selected.url});assert.equal(repeated.added,0);assert.equal(repeated.reused,1);
  state=await api('/api/state');assert.equal(topic().documents.length,1);
  state=(await api('/api/action',{type:'document.update',topicId,documentId:doc.id,payload:{title:'视频口播 · 人工修订验收',source:doc.source,text:doc.text+'\n\n（系统验收：此处是人工修订备注。）'}})).state;
  assert.equal((await api('/api/media/transcript?id='+selected.id)).text,original.text);assert.equal(topic().documents[0].media.assetId,selected.id);
  await api('/api/analyze',{topicId});
  state=await wait('real-model-review',async()=>{const s=await api('/api/state'),j=s.analysisJobs[topicId];if(j&&['failed','cancelled','timed_out'].includes(j.status))throw new Error(j.message);return {done:j?.status==='succeeded',value:s,message:j?.message||'waiting'}});
  assert.equal(topic().analysis.model,'gpt-6-astra');assert.equal(topic().analysis.reasoningEffort,'high');report.analysis={score:topic().analysis.documents[0].score,elapsedMs:topic().analysis.elapsedMs,model:topic().analysis.model,reasoningEffort:topic().analysis.reasoningEffort};
  state=(await api('/api/action',{type:'selection.toggle',topicId,payload:{documentId:doc.id,paragraphIndex:0,kind:'paragraph'}})).state;
  state=(await api('/api/action',{type:'draft.combine',topicId})).state;
  state=(await api('/api/action',{type:'final.save',topicId})).state;const confirmed=topic().finalDraft.text;assert.ok(confirmed);
  state=(await api('/api/action',{type:'topic.update',topicId,payload:{draft:'这是一处未确认的新改动。'}})).state;assert.equal(topic().finalDraft.text,confirmed);
  if(withFeishu){
    state=await wait('feishu-sync',async()=>{const s=await api('/api/state'),a=s.archives.find(a=>a.topicId===topicId);if(a?.sync.status==='failed')throw new Error(a.sync.message);return {done:a?.sync.status==='synced',value:s,message:a?.sync.message}},300);
    const f=new Feishu(root,data);await f.init();const filter={logic:'and',conditions:[['记录编号','==',topicId]]};
    const archives=await f.records(f.config.archiveTableId,['记录编号','最终稿','精选数量','档案状态'],filter);
    const finals=await f.records(f.config.referenceTableId,['记录编号','最终文稿','档案状态'],filter);
    const refs=await f.records(f.config.sourceTableId,['记录编号','来源','原始文案','整体评分'],{logic:'and',conditions:[['记录编号','intersects',topicId+':']]});
    assert.equal(archives.length,1);assert.equal(finals.length,1);assert.equal(refs.length,1);assert.equal(archives[0]['最终稿'],confirmed);assert.equal(finals[0]['最终文稿'],confirmed);assert.equal(refs[0]['来源'],selected.url);assert.equal(refs[0]['整体评分'],report.analysis.score);
    report.feishu={archiveRecord:archives[0].record_id,finalRecord:finals[0].record_id,sourceRecord:refs[0].record_id,verified:true};
  }
  report.videos=media.assets.map(a=>({platform:a.platform,media:a.media,bytes:a.bytes,transcribed:!!a.transcriptId}));report.originalTranscriptPreserved=true;report.onlySelectedVideoTranscribed=true;report.repeatedSourceReused=true;report.finalNotOverwritten=true;report.completed=new Date().toISOString();
  await api('/api/action',{type:'topic.delete',topicId});
  if(withFeishu)await wait('test-record-cleanup',async()=>{const s=await readFile(path.join(data,'state.json'),'utf8').then(JSON.parse);const a=s.archives.find(a=>a.topicId===topicId);return {done:a?.sync.status==='synced',message:a?.sync.message}},300);
  await writeFile(path.join(dir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({VALIDATED:true,...report}));
}catch(e){await writeFile(path.join(dir,'failure.json'),JSON.stringify({message:e.message,stderr,topicId,report},null,2));console.error(JSON.stringify({FAILED:true,message:e.message,directory:dir,stderr}));process.exitCode=1}
finally{child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit')}
