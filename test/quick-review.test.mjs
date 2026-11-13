import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {AnalysisService,ANALYSIS_MODEL,ANALYSIS_EFFORT} from '../lib/analysis.mjs';
import {topicOf,fingerprint} from '../lib/model.mjs';
import {validateReview,reviewPrompt,runReview} from '../lib/quick-review.mjs';
const make=()=>topicOf({title:'同一故事',documents:[{title:'A',text:'甲开场。\n\n乙经过。\n\n丙收尾。'},{title:'B',text:'丁开场。\n\n戊收尾。'}]});
const output=t=>({comparison:'A作主线，B补收尾。',documents:t.documents.map((d,index)=>({index,score:75,summary:'叙述清楚，开头需要更具体。',marks:[{start:0,end:0,label:'improve',reason:'补充具体时间与人物'}]}))});
async function setup(execute,options={}){const dir=await mkdtemp(path.join(tmpdir(),'shiju-review-')),topic=make(),published=[];const service=new AnalysisService({dataDir:dir,getTopic:()=>topic,commit:async(id,a,hash)=>{assert.equal(hash,fingerprint(topic));topic.analysis=structuredClone(a);published.push(a);},execute:args=>execute(args,topic),...options});await service.init();return{dir,topic,published,service};}
test('一组仅请求一次；全部评分及关键建议一起发布，重启仍可查看',async()=>{
  let calls=0;const ctx=await setup(async(args,t)=>{calls++;assert.equal(args.timeout,0);return{analysis:validateReview(t,output(t)),metrics:{elapsedMs:20}};});
  try{const j=await ctx.service.start(ctx.topic.id);await ctx.service.wait(j.id);assert.equal(calls,1);assert.equal(j.limitSeconds,null);assert.equal(j.status,'succeeded');assert.equal(j.completedDocuments,2);assert.equal(j.annotationCount,2);assert.equal(j.within60Seconds,true);assert.equal(ctx.published.length,1);assert.equal(ctx.topic.analysis.model,ANALYSIS_MODEL);assert.equal(ctx.topic.analysis.reasoningEffort,ANALYSIS_EFFORT);assert.equal(ctx.topic.analysis.reviewedParagraphs,5);
    const restarted=new AnalysisService({dataDir:ctx.dir});await restarted.init();assert.equal(restarted.latest()[ctx.topic.id].status,'succeeded');
  }finally{await rm(ctx.dir,{recursive:true,force:true});}
});
test('取消和截止时间都能结束等待，保留上次完整评分',async()=>{
  for(const action of ['cancel','timeout']){
    let enter;const entered=new Promise(r=>enter=r),ctx=await setup(async(args)=>{enter();return new Promise((r,reject)=>args.signal.addEventListener('abort',()=>reject(new Error('停止')),{once:true}));},{totalTimeout:action==='timeout'?35:0});
    try{ctx.topic.analysis=validateReview(ctx.topic,output(ctx.topic));const saved=JSON.stringify(ctx.topic.analysis);const j=await ctx.service.start(ctx.topic.id);await entered;if(action==='cancel')await ctx.service.cancel(j.id);await ctx.service.wait(j.id);assert.equal(j.status,action==='cancel'?'cancelled':'timed_out');assert.equal(ctx.service.active,null);assert.equal(JSON.stringify(ctx.topic.analysis),saved);assert.equal(ctx.published.length,0);
      j.status='running';await ctx.service.save(j);const restarted=new AnalysisService({dataDir:ctx.dir});await restarted.init();assert.equal(restarted.latest()[ctx.topic.id].status,'interrupted');
    }finally{await rm(ctx.dir,{recursive:true,force:true});}
  }
});
test('原稿变化后拒绝写回旧评分，失败原因会持久保存',async()=>{
  const ctx=await setup(async(args,t)=>{const analysis=validateReview(t,output(t));t.documents[0].text+='用户的新编辑';return{analysis,metrics:{}};});
  try{const j=await ctx.service.start(ctx.topic.id);await ctx.service.wait(j.id);assert.equal(j.status,'failed');assert.match(j.message,/变化/);assert.equal(ctx.topic.analysis,null);const saved=JSON.parse(await readFile(path.join(ctx.dir,'jobs',j.id,'job.json'),'utf8'));assert.equal(saved.status,'failed');}finally{await rm(ctx.dir,{recursive:true,force:true});}
});
test('全文完整提交；仅标记关键范围，不伪造普通段落已点评或自动采纳',()=>{
  const t=make(),before=JSON.stringify(t);for(const d of t.documents)for(const part of d.text.split('\n\n'))assert.ok(reviewPrompt(t).includes(part));const raw=output(t);raw.documents[0].marks=[{start:1,end:2,label:'skip',reason:'结尾重复前文且偏题'}];const analysis=validateReview(t,raw);
  assert.equal(JSON.stringify(t),before);assert.deepEqual(analysis.documents[0].paragraphs.map(p=>p.index),[1,2]);assert.equal(analysis.documents[0].paragraphs[0].label,'skip');assert.equal(analysis.annotationCount,2);assert.equal(t.selections.length,0);
});
test('缺稿、重复编号、越界或重叠标记一律拒绝',()=>{
  const t=make();for(const mutate of [x=>x.documents.pop(),x=>x.documents[1].index=0,x=>x.documents[0].marks[0].end=99,x=>x.documents[0].marks.push({...x.documents[0].marks[0]}),x=>x.documents[0].score=101]){const raw=output(t);mutate(raw);assert.throws(()=>validateReview(t,raw));}
});
test('Codex已完成但进程未退出时，立即接收有效结果并清理进程',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'shiju-cli-finish-')),topic=make(),fake=path.join(dir,'fake-codex');
  const events=[{type:'thread.started'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output(topic))}},{type:'turn.completed',usage:{output_tokens:100}}];
  await writeFile(fake,`#!${process.execPath}\nprocess.stdin.resume();\nfor(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  try{const started=performance.now();const result=await runReview({topic,dir,command:fake});assert.ok(performance.now()-started<1500);assert.equal(result.analysis.documents.length,2);assert.equal(result.metrics.within60Seconds,true);}finally{await rm(dir,{recursive:true,force:true});}
});
