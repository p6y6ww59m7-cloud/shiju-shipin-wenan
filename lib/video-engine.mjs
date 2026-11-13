import path from 'node:path';
import os from 'node:os';
import {access,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {existingEngine} from '../video-engine/engine-session.mjs';

export async function restoreVideoHistory(dataDir,history){
  if(!history?.length)return;
  await mkdir(dataDir,{recursive:true,mode:0o700});
  try{await writeFile(path.join(dataDir,'history.json'),JSON.stringify(history),{mode:0o600,flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}
}

export class VideoEngine {
  constructor({root,onSnapshot=async()=>{},onError=()=>{},dataDir,runtimeRoot,initialHistory=[],disabled=false}){
    this.root=root;this.dataDir=dataDir||path.join(os.homedir(),'Library/Application Support/抖音视频导出助手');
    this.runtimeRoot=runtimeRoot;this.onSnapshot=onSnapshot;this.onError=onError;this.disabled=disabled;this.initialHistory=initialHistory;
    this.snapshot={jobs:[],engine:{ready:false,message:'正在连接本机下载与转写服务…'}};
    this.transcripts=new Map();this.stopped=false;this.busy=false;this.connection=null;
  }
  async runtime(){
    for(const root of [this.runtimeRoot,this.root,path.join(os.homedir(),'Applications/抖音视频导出助手.app/Contents/Resources/app')].filter(Boolean)){
      try{await Promise.all(['native/VideoProbe','native/AudioPrepare','native/vendor/yt-dlp','native/vendor/ffmpeg','native/vendor/whisper-cli'].map(f=>access(path.join(root,f))));return root}catch{}
    }
    throw new Error('视频运行资源尚未安装，请运行 npm run setup:video。');
  }
  async connect(){
    if(this.disabled)throw new Error('视频服务已在当前测试环境中关闭。');
    if(this.connection)return this.connection;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const existing=await existingEngine(this.dataDir);if(existing)return this.connection=existing;
      await restoreVideoHistory(this.dataDir,this.initialHistory);
      const runtime=await this.runtime();
      const child=spawn(process.execPath,[path.join(this.root,'server.mjs')],{cwd:this.root,env:{...process.env,PORT:'0',DOUYIN_EXPORT_DATA:this.dataDir,DOUYIN_EXPORT_RUNTIME:runtime},stdio:['ignore','pipe','pipe']});
      this.child=child;let tail='';child.stderr.on('data',c=>{tail=(tail+c).slice(-1600)});
      await new Promise((resolve,reject)=>{
        let text='',done=false;const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve()};
        const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('视频服务启动超时，请稍后重试。'))},15000);
        child.once('error',finish);child.once('exit',code=>finish(new Error('视频服务未能启动：'+(tail||code))));
        child.stdout.on('data',c=>{text+=c;for(const line of text.split('\n')){try{if(JSON.parse(line).url)finish()}catch{}}});
      });
      const session=await existingEngine(this.dataDir);if(!session)throw new Error('视频服务连接尚未就绪。');
      return this.connection=session;
    })();
    try{return await this.connecting}finally{this.connecting=null}
  }
  async request(route,body){
    const c=await this.connect();let response;
    try{response=await fetch(c.url+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{'x-session-token':c.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)})}
    catch(e){this.connection=null;throw new Error('视频服务连接中断，已保存的内容仍在。')}
    if(response.status===403)this.connection=null;
    const result=await response.json();if(!response.ok)throw new Error(result.error||'视频操作暂未完成。');return result;
  }
  async refresh(){
    if(this.busy||this.disabled||this.stopped)return;this.busy=true;
    try{
      const snapshot=await this.request('state');
      for(const job of snapshot.jobs){
        if(job.transcript?.status!=='done')continue;
        const key=job.transcript.files?.json+':'+job.transcript.completedAt;
        if(!this.transcripts.has(key)){try{this.transcripts.set(key,await this.request('transcript?id='+encodeURIComponent(job.id)))}catch{continue}}
        job.transcriptDocument=this.transcripts.get(key);
      }
      this.snapshot=snapshot;this.error='';await this.onSnapshot(snapshot);
    }catch(e){this.error=e.message;this.onError(e)}finally{this.busy=false}
  }
  start(){if(this.disabled)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),1500);this.timer.unref()}
  async stop(){this.stopped=true;clearInterval(this.timer);if(this.child&&!this.child.killed)this.child.kill('SIGTERM')}
}
