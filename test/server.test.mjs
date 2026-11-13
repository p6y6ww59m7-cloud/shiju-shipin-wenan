import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('归档、定稿、删除与恢复走完整 API；保存不重复且草稿不会覆盖定稿',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'shiju-v2-test-'));
  await writeFile(path.join(dir,'state.json'),JSON.stringify({schemaVersion:2,revision:0,topics:[],archives:[],trash:[]}));
  const fake=path.join(dir,'offline-cli');await writeFile(fake,'#!/bin/sh\nprintf \'{"identities":{"user":{"available":false}}}\\n\'\n',{mode:0o700});
  const fakeCodex=path.join(dir,'fake-codex');await writeFile(fakeCodex,`#!${process.execPath}\nif(process.argv.includes('exec')){process.stdin.resume();console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({comparison:'适合口播',documents:[{index:0,score:81,summary:'开头具体，结尾可精简',marks:[{start:0,end:0,label:'recommend',reason:'直接交代看点'}]}]})}}));console.log(JSON.stringify({type:'turn.completed'}));}else console.log('logged in');\n`,{mode:0o700});
  const child=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:'43829',SHIJU_DATA_DIR:dir,SHIJU_VIDEO_DISABLED:'1',LARK_CLI:fake,CODEX_CLI:fakeCodex},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  try{
    await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout '+stderr)),10000);timer.unref();})]);
    const base='http://127.0.0.1:43829';let state=await(await fetch(base+'/api/state')).json();
    const action=async(type,extra={})=>{const r=await fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-Shiju-Token':state.token},body:JSON.stringify({type,...extra})});const json=await r.json();assert.equal(r.status,200,JSON.stringify(json));state=json.state;return json;};
    assert.equal(state.connections.codex.model,'gpt-6-astra');
    const {topicId}=await action('topic.create',{payload:{title:'验收临时选题',documents:[{title:'原文',text:'原文第一段。\n\n原文第二段。'}]}});
    assert.equal(state.archives.length,1);const autoArchiveId=state.archives[0].id;
    const started=await fetch(base+'/api/analyze',{method:'POST',headers:{'Content-Type':'application/json','X-Shiju-Token':state.token},body:JSON.stringify({topicId})});assert.equal(started.status,202);const job=await started.json();
    for(let i=0;i<100;i++){state=await(await fetch(base+'/api/state')).json();if(state.analysisJobs[topicId]?.status==='succeeded')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(state.analysisJobs[topicId].id,job.id);assert.equal(state.analysisJobs[topicId].status,'succeeded');assert.equal(state.archives[0].topic.analysis.documents[0].score,81);
    {const target=()=>state.topics.find(t=>t.id===topicId),doc=target().documents[0];
    await action('selection.toggle',{topicId,payload:{documentId:doc.id,paragraphIndex:1}});
    await action('selection.toggle',{topicId,payload:{documentId:doc.id,paragraphIndex:0}});
    const [second,first]=target().selections.map(s=>s.id);
    assert.deepEqual(target().selections.map(s=>s.text),['原文第二段。','原文第一段。']);
    await action('selection.move',{topicId,selectionId:first,toIndex:0});
    assert.equal(target().selections[0].id,first);
    await action('draft.combine',{topicId});assert.equal(target().draft,'原文第一段。\n\n原文第二段。');
    await action('selection.reset-order',{topicId});assert.deepEqual(target().selections.map(s=>s.id),[second,first]);
    await action('topic.update',{topicId,payload:{draft:'开头\n\n结尾'}});
    const inserted=await action('draft.append',{topicId,selectionId:first,at:2,expectedDraft:target().draft});
    assert.equal(target().draft,'开头\n\n原文第一段。\n\n结尾');
    assert.equal(inserted.draftCursor,'开头\n\n原文第一段。'.length);
    await action('draft.append',{topicId,selectionId:second,at:inserted.draftCursor,expectedDraft:target().draft});
    assert.equal(target().draft,'开头\n\n原文第一段。\n\n原文第二段。\n\n结尾');
    await action('draft.move',{topicId,fromIndex:3,toIndex:0,expectedDraft:target().draft});assert.ok(target().draft.startsWith('结尾\n\n开头'));
    await action('topic.update',{topicId,payload:{draft:'正文\n\n  \n\n结尾'}});
    await action('draft.clean',{topicId});assert.equal(target().draft,'正文\n\n结尾');}
    {const target=()=>state.topics.find(t=>t.id===topicId),doc=target().documents[0];
    await action('topic.update',{topicId,payload:{draft:'原文第一段。'}});
    await action('document.update',{topicId,documentId:doc.id,payload:{...doc,title:'修改后的原稿',text:'改好的第一段。\n\n原文第二段。'}});
    assert.equal(target().draft,'改好的第一段。');assert.ok(target().selections.some(s=>s.text==='改好的第一段。'));
    assert.equal(state.archives[0].id,autoArchiveId);assert.equal(state.archives[0].topic.documents[0].text,doc.text.replace('原文第一段。','改好的第一段。'));assert.equal(state.archives[0].topic.draft,'改好的第一段。');
    const selectionIds=target().selections.map(s=>s.id);await action('document.remove',{topicId,documentId:doc.id});assert.equal(target().documents.length,0);assert.equal(target().selections.length,0);assert.equal(target().draft,'改好的第一段。');
    await action('document.restore',{topicId,documentId:doc.id});assert.deepEqual(target().selections.map(s=>s.id),selectionIds);assert.equal(target().documents.length,1);}
    await action('topic.update',{topicId,payload:{draft:'这是确认的最终文稿。'}});
    await action('final.save',{topicId});const first=state.archives.find(a=>a.topicId===topicId);
    assert.equal(first.topic.finalDraft.text,'这是确认的最终文稿。');
    const repeated=await action('final.save',{topicId});assert.equal(repeated.reused,true);assert.equal(state.archives.length,1);
    await action('topic.update',{topicId,payload:{draft:'这是尚未确认的修改。'}});
    assert.equal(state.archives[0].topic.draft,'这是尚未确认的修改。');assert.equal(state.archives[0].topic.finalDraft.text,'这是确认的最终文稿。');
    await action('round.save',{topicId});assert.equal(state.archives.length,1);assert.equal(state.archives[0].history.length,first.history.length+1);
    assert.equal(state.archives[0].topic.finalDraft.text,'这是确认的最终文稿。');assert.equal(state.archives[0].topic.draft,'这是尚未确认的修改。');
    await action('topic.delete',{topicId});assert.ok(!state.topics.some(t=>t.id===topicId));assert.equal(state.archives.length,0);assert.equal(state.trash[0].topic.draft,'这是尚未确认的修改。');
    await action('topic.restore',{topicId});assert.equal(state.archives.length,1);assert.equal(state.trash.length,0);assert.equal(state.archives[0].id,first.id);assert.equal(state.archives[0].topic.finalDraft.text,'这是确认的最终文稿。');
    assert.equal((await readdir(path.join(dir,'archives'))).filter(x=>x.endsWith('.json')).length,1);
    const oldSyncKey=state.archives[0].syncKey;const syncResponse=await fetch(base+'/api/feishu/sync',{method:'POST',headers:{'Content-Type':'application/json','X-Shiju-Token':state.token},body:'{}'});assert.equal(syncResponse.status,202);state=await(await fetch(base+'/api/state')).json();assert.equal(state.archives.length,1);assert.notEqual(state.archives[0].syncKey,oldSyncKey);assert.equal(state.archives[0].topic.finalDraft.text,'这是确认的最终文稿。');
    const rejected=await fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'topic.delete',topicId})});assert.equal(rejected.status,403);
  }finally{child.kill('SIGTERM');await once(child,'exit');await rm(dir,{recursive:true,force:true});}
});
