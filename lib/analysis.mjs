import path from 'node:path';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import {uid,now,fingerprint,paragraphs} from './model.mjs';
import {runReview,REVIEW_MODEL,REVIEW_EFFORT,REVIEW_VERSION} from './quick-review.mjs';

export const ANALYSIS_MODEL=REVIEW_MODEL;
export const ANALYSIS_EFFORT=REVIEW_EFFORT;
export class AnalysisService {
  constructor({dataDir,getTopic,commit,execute=runReview,totalTimeout=0}){
    Object.assign(this,{dataDir,getTopic,commit,execute,totalTimeout});this.jobs=new Map();this.activeId=null;this.controllers=new Map();this.writes=new Map();this.tasks=new Map();
  }
  get active(){return this.jobs.get(this.activeId)||null;}
  latest(){const latest={};for(const job of [...this.jobs.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)))latest[job.topicId]=job;return latest;}
  async init(){await mkdir(path.join(this.dataDir,'jobs'),{recursive:true});for(const id of await readdir(path.join(this.dataDir,'jobs'))){try{const job=JSON.parse(await readFile(path.join(this.dataDir,'jobs',id,'job.json'),'utf8'));if(!job.id||!job.topicId)continue;this.jobs.set(job.id,job);if(['running','cancelling'].includes(job.status)){job.status='interrupted';job.finishedAt=now();job.message='上次分析因服务重启而中断。原稿及上次完成的评分仍保留，可以重新评分。';await this.save(job);}}catch{}}}
  async save(job){const snapshot=JSON.stringify(job,null,2),dir=path.join(this.dataDir,'jobs',job.id);const p=(this.writes.get(job.id)||Promise.resolve()).catch(()=>{}).then(async()=>{await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'job.json.tmp'),snapshot,{mode:0o600});await rename(path.join(dir,'job.json.tmp'),path.join(dir,'job.json'));});this.writes.set(job.id,p);return p;}
  async start(topicId){
    if(this.activeId)throw new Error('已有分析正在进行，可以先取消当前任务');
    const topic=structuredClone(this.getTopic(topicId));if(!topic.documents.length)throw new Error('先添加至少一篇文案');if(topic.documents.length>8)throw new Error('单组最多分析8篇文案');
    const job={id:uid(),topicId,hash:fingerprint(topic),model:ANALYSIS_MODEL,reasoningEffort:ANALYSIS_EFFORT,reviewVersion:REVIEW_VERSION,status:'running',stage:'review',startedAt:now(),lastActivityAt:now(),message:'正在比较全部原稿，生成评分和关键取舍建议',totalDocuments:topic.documents.length,totalParagraphs:topic.documents.reduce((s,d)=>s+paragraphs(d.text).length,0),completedDocuments:0,limitSeconds:this.totalTimeout>0?this.totalTimeout/1000:null};
    this.jobs.set(job.id,job);this.activeId=job.id;const controller=new AbortController();this.controllers.set(job.id,controller);
    try{await this.save(job);}catch(e){this.activeId=null;this.controllers.delete(job.id);job.status='failed';job.message=e.message;throw e;}
    const work=this.perform(job,topic,controller);this.tasks.set(job.id,work);void work.finally(()=>this.tasks.delete(job.id)).catch(()=>{});return job;
  }
  async cancel(id){const job=this.jobs.get(id);if(!job||job.status!=='running')throw new Error('这个任务已经结束');job.status='cancelling';job.message='正在取消，本次不会覆盖上次结果';this.controllers.get(id)?.abort();await this.save(job);return job;}
  async wait(id){await this.tasks.get(id);return this.jobs.get(id);}
  async perform(job,topic,controller){
    let expired=false;const started=Date.parse(job.startedAt),timer=this.totalTimeout>0?setTimeout(()=>{expired=true;controller.abort();},this.totalTimeout):null;
    try{
      const {analysis,metrics}=await this.execute({topic,dir:path.join(this.dataDir,'jobs',job.id,'review'),effort:ANALYSIS_EFFORT,timeout:this.totalTimeout>0?Math.max(1,this.totalTimeout-2000):0,signal:controller.signal,onEvent:({type})=>{if(['thread.started','turn.started','item.completed','turn.completed'].includes(type)){job.lastActivityAt=now();job.connection='connected';}}});
      if(controller.signal.aborted)throw new Error('分析已停止');
      if(fingerprint(this.getTopic(job.topicId))!==job.hash)throw new Error('分析期间原稿或用途发生变化，请重新评分');
      if(analysis.hash!==job.hash||analysis.reviewVersion!==REVIEW_VERSION)throw new Error('评分结果与本次原稿不匹配');
      analysis.jobId=job.id;analysis.elapsedMs=Date.now()-started;
      await this.commit(job.topicId,analysis,job.hash,true);
      job.status='succeeded';job.stage='complete';job.completedDocuments=job.totalDocuments;job.annotationCount=analysis.annotationCount;job.metrics=metrics;job.message=`${job.totalDocuments} 篇评分已完成，标出 ${analysis.annotationCount} 处关键建议。点击原文标签查看理由。`;
    }catch(e){job.status=expired||e.code==='REVIEW_TIMEOUT'?'timed_out':controller.signal.aborted?'cancelled':'failed';job.message=job.status==='timed_out'?'分析达到配置的等待上限，原稿和上次结果仍保留。':job.status==='cancelled'?'已取消本次分析，原稿和上次结果仍保留。':e.message;}
    finally{clearTimeout(timer);job.finishedAt=now();job.elapsedMs=Date.now()-started;job.within60Seconds=job.status==='succeeded'&&job.elapsedMs<60000;try{await this.save(job);}finally{if(this.activeId===job.id)this.activeId=null;this.controllers.delete(job.id);}}
  }
}
