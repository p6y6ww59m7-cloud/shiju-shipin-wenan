import {createHash} from 'node:crypto';
import {sourceKey} from '../video-engine/cache.mjs';
import {documentOf,now,logOperation} from './model.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function initializeMedia(state){state.mediaAssets??=[];state.mediaHistory??=[];state.mediaVersion=1}

export function reconcileMedia(state,snapshot){
  initializeMedia(state);let changed=false;
  for(const job of snapshot.jobs){
    const {transcriptDocument,candidates,...record}=job,saved={...record,candidates:[]};
    const oldIndex=state.mediaHistory.findIndex(j=>j.id===job.id);
    if(oldIndex<0){state.mediaHistory.push(saved);changed=true}
    else if(JSON.stringify(state.mediaHistory[oldIndex])!==JSON.stringify(saved)){state.mediaHistory[oldIndex]=saved;changed=true}
    const key=sourceKey(job.url);let asset=state.mediaAssets.find(a=>a.sourceKey===key);
    if(!asset){asset={id:hash(key).slice(0,24),sourceKey:key,topicIds:[],imports:[],transcripts:[],created:job.created||Date.now(),jobIds:[]};state.mediaAssets.push(asset);changed=true}
    if(!asset.jobIds.includes(job.id)){asset.jobIds.push(job.id);changed=true}
    // History is chronological. Prefer the latest attempt without throwing away earlier transcripts.
    const activity=Math.max(job.created||0,job.reusedAt||0);
    const latest=activity>=(asset.lastActivity||asset.attemptCreated||0);
    if(latest){
      const patch={jobId:job.id,attemptCreated:job.created,lastActivity:activity,url:job.url,title:job.title,author:job.author,platform:job.platform,platformLabel:job.platformLabel,status:job.status,message:job.message,autoTranscribe:job.autoTranscribe||false};
      if(job.file)Object.assign(patch,{file:job.file,bytes:job.bytes,media:job.media,duration:job.duration});
      if(job.downloadFinished)patch.downloadFinished=job.downloadFinished;
      if(job.transcript)patch.transcriptStatus={status:job.transcript.status,message:job.transcript.message,progress:job.transcript.progress};
      for(const[k,v]of Object.entries(patch))if(JSON.stringify(asset[k])!==JSON.stringify(v)){asset[k]=v;changed=true}
    }
    const doc=job.transcriptDocument;
    if(doc?.text?.trim()&&Array.isArray(doc.segments)){
      const id=hash(JSON.stringify([doc.text,doc.segments,doc.model||'',doc.created||job.transcript?.completedAt||''])).slice(0,24);
      if(!asset.transcripts.some(t=>t.id===id)){
        asset.transcripts.push({id,text:doc.text,segments:doc.segments,language:doc.language,model:doc.model,precision:doc.precision,created:doc.created,files:job.transcript.files,videoFile:job.file,jobId:job.id});changed=true;
      }
      if(latest&&asset.transcriptId!==id){asset.transcriptId=id;changed=true}
    }
  }
  return changed;
}

export function attachMedia(asset,topicId){if(!asset.topicIds.includes(topicId))asset.topicIds.push(topicId)}

export function importMediaDocument(state,asset,topicId,{transcriptId=asset.transcriptId,explicit=false}={}){
  const topic=state.topics.find(t=>t.id===topicId);if(!topic)return {status:'missing_topic'};
  const transcript=asset.transcripts.find(t=>t.id===transcriptId);if(!transcript)return {status:'waiting_transcript'};
  const existing=topic.documents.find(d=>d.media?.assetId===asset.id&&d.media?.transcriptId===transcript.id);
  if(existing)return {status:'imported',documentId:existing.id};
  const prior=asset.imports.find(i=>i.topicId===topicId);
  // Reprocessing speech must not overwrite or silently replace a user's edited document.
  if(!explicit&&prior?.documentId)return {status:prior.transcriptId===transcript.id?'already_imported':'new_version'};
  if(topic.documents.length>=8)return {status:'capacity',message:'当前已有 8 篇对比文案，素材已保留；移出一篇后可再加入。'};
  if(transcript.text.length>40000)return {status:'too_long',message:'转写超过单篇 4 万字，全文已保留在素材库，请分段加入文案。'};
  const doc=documentOf({title:asset.title||'视频口播',text:transcript.text,source:asset.url});
  doc.media={assetId:asset.id,transcriptId:transcript.id,importedAt:now()};
  topic.documents.push(doc);topic.analysis=null;topic.updatedAt=now();
  const record={topicId,documentId:doc.id,transcriptId:transcript.id};
  asset.imports=asset.imports.filter(i=>i.topicId!==topicId);asset.imports.push(record);
  logOperation(topic,'media.import','从视频素材导入口播文案：'+doc.title);
  return {status:'imported',documentId:doc.id,created:true};
}

export function publicMedia(state,snapshot,error=''){
  const jobs=new Map((snapshot.jobs||[]).map(j=>[j.id,j]));
  return {paused:!!snapshot.paused,engine:snapshot.engine,settings:snapshot.settings||{proxy:'auto'},error,assets:state.mediaAssets.map(a=>{
    const job=jobs.get(a.jobId),current=a.transcripts.find(t=>t.id===a.transcriptId);
    return {...a,transcripts:a.transcripts.map(t=>({id:t.id,created:t.created,characters:t.text.length,segments:t.segments.length})),characters:current?.text.length||0,
      progress:job?{bytes:job.bytes,total:job.total,speed:job.speed,eta:job.eta,stage:job.downloadStage,access:job.access,transcript:job.transcript?{status:job.transcript.status,progress:job.transcript.progress,message:job.transcript.message}:a.transcriptStatus}:null};
  }).sort((a,b)=>(b.lastActivity||b.attemptCreated||b.created)-(a.lastActivity||a.attemptCreated||a.created))};
}
