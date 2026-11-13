import test from 'node:test';
import assert from 'node:assert/strict';
import {topicOf} from '../lib/model.mjs';
import {updateDocument,removeDocument} from '../lib/source-sync.mjs';
import {initializeMedia,reconcileMedia,attachMedia,importMediaDocument,publicMedia} from '../lib/media.mjs';

const make=()=>({topics:[topicOf({title:'原有选题',documents:[{title:'旧稿',text:'原有文案。'}]})],archives:[{id:'old',topic:{finalDraft:{text:'已确认的最终稿。'}}}],trash:[{id:'old-trash'}]});
const job=(id,url,withText=false,created=1)=>({id,url,created,platform:'youtube',platformLabel:'YouTube',title:'视频 '+id,status:'done',file:'/videos/'+id+'.mp4',bytes:20,autoTranscribe:withText,media:{duration:20,width:3840,height:2160,audioTracks:1},...(withText?{transcript:{status:'done',completedAt:1,files:{json:'/videos/'+id+'.json'}},transcriptDocument:{text:'第一段口播。\n\n第二段口播。',segments:[{start:0,end:2000,text:'第一段口播。'},{start:2000,end:4000,text:'第二段口播。'}],model:'large-v3',precision:'FP16',created:'2026-11-13T00:00:00Z'}}:{})});

test('三条混合素材只有勾选的一条导入，旧档案回收站与4K文件完整保留',()=>{
  const state=make(),oldArchive=JSON.stringify(state.archives),oldTrash=JSON.stringify(state.trash);initializeMedia(state);
  const jobs=[job('a','https://youtu.be/first',false),job('b','https://b23.tv/second',true),job('c','https://x.com/person/status/123',false)];
  reconcileMedia(state,{jobs});for(const asset of state.mediaAssets){attachMedia(asset,state.topics[0].id);importMediaDocument(state,asset,state.topics[0].id)}
  assert.equal(state.mediaAssets.length,3);assert.equal(state.topics[0].documents.length,2);assert.equal(state.topics[0].documents[1].source,jobs[1].url);
  assert.equal(state.mediaAssets[0].media.height,2160);assert.equal(JSON.stringify(state.archives),oldArchive);assert.equal(JSON.stringify(state.trash),oldTrash);
  assert.equal(reconcileMedia(state,{jobs}),false);for(const asset of state.mediaAssets)importMediaDocument(state,asset,state.topics[0].id);assert.equal(state.topics[0].documents.length,2);
});

test('同一作品不同YouTube网址和重新下载复用素材，已有文案不重复',()=>{
  const state=make();reconcileMedia(state,{jobs:[job('a','https://youtu.be/same',true,1),job('b','https://www.youtube.com/watch?v=same',true,2)]});
  assert.equal(state.mediaAssets.length,1);const asset=state.mediaAssets[0];assert.deepEqual(asset.jobIds,['a','b']);assert.equal(asset.jobId,'b');
  const first=importMediaDocument(state,asset,state.topics[0].id),second=importMediaDocument(state,asset,state.topics[0].id,{explicit:true});assert.equal(first.documentId,second.documentId);assert.equal(state.topics[0].documents.length,2);
});

test('复用旧的完整文件会显示成功并排到最近；后续重新下载仍默认不转写',()=>{
  const state=make(),old=job('old','https://youtu.be/same',true,1),failed={...job('failed','https://youtu.be/same',false,3),status:'error',file:undefined};
  old.reusedAt=10;reconcileMedia(state,{jobs:[old,failed,job('other','https://youtu.be/other',false,5)]});
  const asset=state.mediaAssets.find(a=>a.sourceKey.includes('same'));assert.equal(asset.jobId,'old');assert.equal(asset.status,'done');assert.equal(publicMedia(state,{jobs:[]}).assets[0].id,asset.id);
  reconcileMedia(state,{jobs:[old,failed,{...job('fresh','https://youtu.be/same',false,20),status:'queued',file:undefined}]});
  assert.equal(asset.jobId,'fresh');assert.equal(asset.autoTranscribe,false);assert.equal(asset.status,'queued');
});

test('原始转写、修订稿和已确认稿分开保存；新版转写不覆盖修订稿',()=>{
  const state=make(),j=job('a','https://youtu.be/example',true);reconcileMedia(state,{jobs:[j]});const asset=state.mediaAssets[0],t=state.topics[0];
  const original=asset.transcripts[0].text,result=importMediaDocument(state,asset,t.id);
  updateDocument(t,result.documentId,{title:'修订稿',text:'用户核对后改好的人名。',source:j.url});assert.equal(t.documents[1].media.assetId,asset.id);assert.equal(asset.transcripts[0].text,original);
  j.transcriptDocument={...j.transcriptDocument,text:'模型重新识别的新版本。',created:'2026-11-13T01:00:00Z'};reconcileMedia(state,{jobs:[j]});
  assert.equal(importMediaDocument(state,asset,t.id).status,'new_version');assert.equal(t.documents[1].text,'用户核对后改好的人名。');assert.equal(asset.transcripts.length,2);
  assert.equal(state.archives[0].topic.finalDraft.text,'已确认的最终稿。');
});

test('对比满8篇时素材仍保留，空出位置后可导入；删除后不会被后台复活',()=>{
  const state=make(),t=state.topics[0];while(t.documents.length<8)t.documents.push({...t.documents[0],id:'d'+t.documents.length});
  reconcileMedia(state,{jobs:[job('a','https://youtu.be/example',true)]});const asset=state.mediaAssets[0];
  assert.equal(importMediaDocument(state,asset,t.id).status,'capacity');assert.ok(asset.transcripts[0].text);
  t.documents.pop();const added=importMediaDocument(state,asset,t.id);assert.equal(added.created,true);removeDocument(t,added.documentId);
  assert.equal(importMediaDocument(state,asset,t.id).status,'already_imported');assert.ok(!t.documents.some(d=>d.id===added.documentId));
});

test('全文超过单篇限制仍完整保存；素材可以关联多个选题，状态不暴露服务令牌',()=>{
  const state=make(),j=job('a','https://youtu.be/example',true);j.transcriptDocument.text='字'.repeat(40001);reconcileMedia(state,{jobs:[j]});const asset=state.mediaAssets[0];
  assert.equal(importMediaDocument(state,asset,state.topics[0].id).status,'too_long');assert.equal(asset.transcripts[0].text.length,40001);
  attachMedia(asset,'one');attachMedia(asset,'two');attachMedia(asset,'one');assert.deepEqual(asset.topicIds,['one','two']);
  const data=publicMedia(state,{jobs:[j],token:'private-token',engine:{ready:true}});assert.equal(JSON.stringify(data).includes('private-token'),false);assert.equal(data.assets[0].transcripts[0].text,undefined);
});
