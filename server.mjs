import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile,rename,mkdir,readdir,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {seedState,uid,now,topicOf,documentOf,selectFragment,archiveOf,fingerprint,migrateArchives,archiveSignature,logOperation} from './lib/model.mjs';
import {run} from './lib/process.mjs';
import {updateDocument,reconcileLegacySelections,removeDocument,restoreDocument} from './lib/source-sync.mjs';
import {Feishu} from './lib/feishu.mjs';
import {AnalysisService,ANALYSIS_MODEL,ANALYSIS_EFFORT} from './lib/analysis.mjs';
import {moveSelection,appendDraft,insertDraft,cleanDraft,moveDraftParagraph} from './lib/composition.mjs';
import {VideoEngine} from './lib/video-engine.mjs';
import {initializeMedia,reconcileMedia,attachMedia,importMediaDocument,publicMedia} from './lib/media.mjs';
import {streamMedia} from './lib/media-files.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url)),DATA=process.env.SHIJU_DATA_DIR||path.join(ROOT,'data');
const PORT=Number(process.env.PORT||43828),TOKEN=randomBytes(24).toString('hex');
await mkdir(path.join(DATA,'archives'),{recursive:true});await mkdir(path.join(DATA,'jobs'),{recursive:true});
const statePath=path.join(DATA,'state.json');let state;
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state=seedState();}
if(state.schemaVersion<2){
  await mkdir(path.join(DATA,'backups'),{recursive:true});
  await writeFile(path.join(DATA,'backups','before-v2-'+Date.now()+'.json'),JSON.stringify(state,null,2),{mode:0o600});
  migrateArchives(state);
  for(const a of state.archives)await writeFile(path.join(DATA,'archives',a.id+'.json'),JSON.stringify(a,null,2),{mode:0o600});
  const keep=new Set(state.archives.map(a=>a.id+'.json'));
  for(const filename of await readdir(path.join(DATA,'archives')))if(filename.endsWith('.json')&&!keep.has(filename))await unlink(path.join(DATA,'archives',filename));
}
state.trash??=[];
if(!state.mediaVersion){await mkdir(path.join(DATA,'backups'),{recursive:true});await writeFile(path.join(DATA,'backups','before-video-integration-'+Date.now()+'.json'),JSON.stringify(state,null,2),{mode:0o600});}
initializeMedia(state);
if(state.topics.some(t=>!t.sourceSyncVersion)){await mkdir(path.join(DATA,'backups'),{recursive:true});await writeFile(path.join(DATA,'backups','before-source-sync-'+Date.now()+'.json'),JSON.stringify(state,null,2),{mode:0o600});for(const t of state.topics)reconcileLegacySelections(t);}
const feishu=new Feishu(ROOT,DATA);await feishu.init();
let queue=Promise.resolve(),syncing=false,syncRequested=false,authFlow=null,syncTimer;
const serial=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
async function persist(){state.revision++;const tmp=statePath+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2),{mode:0o600});await rename(tmp,statePath);}
await persist();
let codexStatus={available:false,message:'待检查'};let feishuStatus=await feishu.status();
async function refreshStatus(){const r=await run(process.env.CODEX_CLI||'codex',['login','status'],{cwd:ROOT,timeout:15000});codexStatus={available:r.code===0,model:ANALYSIS_MODEL,reasoningEffort:ANALYSIS_EFFORT,modelLabel:'GPT-6 Astra · 高',message:r.code===0?'已连接本机 Codex · GPT-6 Astra · 高':'本机 Codex 尚未登录'};feishuStatus=await feishu.status();}
await refreshStatus();
const publicState=()=>{const {mediaAssets,mediaHistory,...rest}=state;return {...rest,mediaCount:mediaAssets.length,archives:state.archives.filter(a=>!a.deletedAt),token:TOKEN,connections:{codex:codexStatus,feishu:feishuStatus},activeAnalysis:analysisService.active,analysisJobs:analysisService.latest()}};
const getTopic=id=>{const t=state.topics.find(t=>t.id===id);if(!t)throw new Error('选题不存在');return t;};
function markUpdated(t){t.updatedAt=now();}
const analysisService=new AnalysisService({dataDir:DATA,getTopic,commit:(id,analysis,hash,complete)=>serial(async()=>{
  const current=getTopic(id);if(fingerprint(current)!==hash)throw new Error('分析期间原稿或用途发生变化，请重新分析');
  current.analysis=analysis;if(complete)logOperation(current,'analysis','通过 Codex · GPT-6 Astra 完成精简评分');markUpdated(current);await saveArchive(current,{automatic:true});scheduleSync();
})});
await analysisService.init();
const videoEngine=new VideoEngine({root:process.env.SHIJU_VIDEO_ENGINE_ROOT||path.join(ROOT,'video-engine'),dataDir:process.env.SHIJU_VIDEO_DATA_DIR,runtimeRoot:process.env.SHIJU_VIDEO_RUNTIME,initialHistory:state.mediaHistory,disabled:process.env.SHIJU_VIDEO_DISABLED==='1',onSnapshot:synchronizeMedia});
async function synchronizeMedia(snapshot){
  return serial(async()=>{
    const changed=reconcileMedia(state,snapshot);let imported=false;
    for(const asset of state.mediaAssets)for(const topicId of asset.topicIds){
      if(analysisService.active?.topicId===topicId)continue;
      const result=importMediaDocument(state,asset,topicId);
      if(result.created){imported=true;await saveArchive(getTopic(topicId),{automatic:true})}
    }
    if(changed||imported)await persist();if(imported)scheduleSync();
  });
}
async function syncPending(){
  if(syncing){syncRequested=true;return;}syncing=true;
  try{
    feishuStatus=await feishu.status();
    for(const item of state.archives.filter(a=>a.sync.status!=='synced')){
      const archive=structuredClone(item),key=archive.syncKey;
      const update=async(sync)=>serial(async()=>{
        const current=state.archives.find(a=>a.id===archive.id);
        if(!current)return;
        if(current.syncKey!==key){syncRequested=true;return;}
        current.sync=sync;await persist();await writeArchive(current);
      });
      if(!feishuStatus.available){await update({status:'needs_auth',message:'本机已保存；连接飞书后可继续同步'});continue;}
      try{
        await update({...archive.sync,status:'syncing',message:'正在同步到飞书…'});
        const result=await feishu.sync(archive);
        await update({status:'synced',message:archive.deletedAt?'已移入回收站，飞书已隐藏':'已同步到飞书',...result,syncedAt:now()});
      }catch(e){feishu.lastError=e.message;await update({...archive.sync,status:'failed',message:e.message});}
    }
    feishuStatus=await feishu.status();
  }finally{syncing=false;if(syncRequested){syncRequested=false;void syncPending();}}
}
async function writeArchive(a){const file=path.join(DATA,'archives',a.id+'.json');await writeFile(file+'.tmp',JSON.stringify(a,null,2),{mode:0o600});await rename(file+'.tmp',file);}
function scheduleSync(){clearTimeout(syncTimer);syncTimer=setTimeout(()=>{void syncPending().catch(e=>console.error('飞书同步失败：',e.message));},1200);syncTimer.unref();}
async function saveArchive(t,{automatic=false,force=false}={}){
  const latest=state.archives.find(a=>a.topicId===t.id),signature=archiveSignature(t);
  if(!t.documents.length&&!latest){if(automatic){await persist();return {skipped:true};}throw new Error('请先添加参考文案');}
  const checkpointMatches=latest?.history?.at(-1)&&archiveSignature(latest.history.at(-1).topic)===signature;
  if(latest?.signature===signature&&(automatic||checkpointMatches)){
    if(force){latest.syncKey=uid();latest.sync={status:'pending',message:'正在核对并同步当前内容'};await writeArchive(latest);await persist();}
    return {archiveId:latest.id,reused:true};
  }
  if(!automatic)logOperation(t,'archive.save',`更新选题档案 · 第 ${(latest?.round||0)+1} 版`);
  // Automatic updates keep the same archive and explicit version checkpoints.
  // Editing a draft must not create a full history snapshot on every keystroke.
  const archive=automatic&&latest?{...latest,savedAt:now(),topic:structuredClone(t),signature,syncKey:uid(),sync:{status:'pending',message:'内容已更新，等待同步飞书'}}:archiveOf(t,state.archives);
  state.archives=state.archives.filter(a=>a.topicId!==t.id);state.archives.unshift(archive);
  await writeArchive(archive);await persist();return {archiveId:archive.id};
}
async function refreshArchives({force=false}={}){for(const t of state.topics)await saveArchive(t,{automatic:true,force});}
async function action(body){
  return serial(async()=>{
    let result={};
    let t=body.topicId&&!['topic.create','topic.restore'].includes(body.type)?getTopic(body.topicId):null;
    switch(body.type){
      case 'topic.create': {const topic=topicOf(body.payload);logOperation(topic,'topic.create','创建选题');state.topics.unshift(topic);await saveArchive(topic,{automatic:true});scheduleSync();return {topicId:topic.id};}
      case 'topic.update': {for(const key of ['title','audience','purpose','format','draft','notes'])if(body.payload[key]!==undefined){const value=String(body.payload[key]);if(value.length>100000)throw new Error('内容过长');if(key==='title'&&!value.trim())throw new Error('选题名称不能为空');t[key]=value;}if(t.analysis&&t.analysis.hash!==fingerprint(t))t.analysis=null;break;}
      case 'document.add': {if(t.documents.length>=8)throw new Error('每个选题最多8篇文案');t.documents.push(documentOf(body.payload));t.analysis=null;break;}
      case 'document.update': result.sourceSync=updateDocument(t,body.documentId,documentOf(body.payload));break;
      case 'document.remove': removeDocument(t,body.documentId);break;
      case 'document.restore': restoreDocument(t,body.documentId);break;
      case 'selection.restore-old': {const s=t.previousSelections?.find(s=>s.id===body.selectionId);if(!s)throw new Error('旧版精选不存在');if(!t.selections.some(x=>x.id===s.id))t.selections.push({...s,sourceDetached:true});t.previousSelections=t.previousSelections.filter(x=>x.id!==s.id);break;}
      case 'selection.toggle': selectFragment(t,body.payload);break;
      case 'selection.remove': t.selections=t.selections.filter(s=>s.id!==body.selectionId);break;
      case 'selection.note': {const s=t.selections.find(s=>s.id===body.selectionId);if(!s)throw new Error('精选不存在');s.note=String(body.note).slice(0,2000);break;}
      case 'selection.move': moveSelection(t,body);break;
      case 'selection.reset-order': t.selections.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));break;
      case 'draft.append': {
        const s=t.selections.find(s=>s.id===body.selectionId);if(!s)throw new Error('精选不存在');
        if(body.at!==undefined){if(body.expectedDraft!==t.draft)throw new Error('文稿已变化，请重新点击插入位置');const left=t.draft.slice(0,body.at).trimEnd();t.draft=insertDraft(t.draft,s.text,body.at);result.draftCursor=(left?left.length+2:0)+s.text.trim().length;}
        else {t.draft=appendDraft(t.draft,s.text);result.draftCursor=t.draft.length;}break;
      }
      case 'draft.combine': t.draft=appendDraft(t.draft,t.selections.map(s=>s.text.trim()).join('\n\n'));break;
      case 'draft.clean': t.draft=cleanDraft(t.draft);break;
      case 'draft.move': {
        if(body.expectedDraft!==t.draft)throw new Error('文稿已变化，请刷新段落后调整');
        t.draft=moveDraftParagraph(t.draft,body.fromIndex,body.toIndex);break;
      }
      case 'round.save': return saveArchive(t);
      case 'final.save': {
        if(!t.draft.trim())throw new Error('先在组稿间写入最终文稿');
        if(!t.documents.length)throw new Error('请先添加参考文案');
        if(t.finalDraft?.text!==t.draft){t.finalDraft={text:t.draft,confirmedAt:now()};logOperation(t,'final.save','确认最终文稿');markUpdated(t);}
        return saveArchive(t);
      }
      case 'topic.delete': {
        if(analysisService.active?.topicId===t.id)throw new Error('请等当前分析结束后再删除');
        const deletedAt=now();logOperation(t,'topic.delete','删除选题，移入回收站');
        state.topics=state.topics.filter(x=>x.id!==t.id);state.trash.unshift({topic:structuredClone(t),deletedAt});
        const a=state.archives.find(a=>a.topicId===t.id);if(a){a.deletedAt=deletedAt;a.topic.operations=structuredClone(t.operations);a.syncKey=uid();a.sync={status:'pending',message:'等待同步删除状态'};await writeArchive(a);}
        await persist();return {};
      }
      case 'topic.restore': {
        const item=state.trash.find(x=>x.topic.id===body.topicId);if(!item)throw new Error('回收站中没有这个选题');
        logOperation(item.topic,'topic.restore','从回收站恢复选题');state.topics.unshift(item.topic);state.trash=state.trash.filter(x=>x!==item);
        const a=state.archives.find(a=>a.topicId===body.topicId);if(a){delete a.deletedAt;a.topic.operations=structuredClone(item.topic.operations);a.syncKey=uid();a.sync={status:'pending',message:'等待同步恢复状态'};await writeArchive(a);}
        await persist();return {topicId:body.topicId};
      }
      default: throw new Error('未知操作');
    }
    const labels={'topic.update':Object.keys(body.payload||{}).includes('draft')?'编辑组稿':'更新选题信息或备注','document.add':'添加参考文案','document.update':'编辑原文并同步精选与组稿','document.remove':'删除参考文案（可恢复）','document.restore':'恢复参考文案','selection.restore-old':'找回旧版精选','selection.toggle':'调整精选内容','selection.remove':'取消一处精选','selection.note':'更新精选备注','selection.move':'调整精选顺序','selection.reset-order':'恢复精选点击顺序','draft.append':'将精选放入组稿','draft.combine':'按精选顺序追加全部素材','draft.clean':'整理文稿空行','draft.move':'调整文稿段落顺序'};
    logOperation(t,body.type==='topic.update'&&body.payload?.draft!==undefined?'draft.edit':body.type,labels[body.type]||'更新选题');
    markUpdated(t);await saveArchive(t,{automatic:true});scheduleSync();return result;
  });
}
async function readBody(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>1500000)throw new Error('请求内容过大');}return data?JSON.parse(data):{};}
const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
    if(!['127.0.0.1','localhost'].includes((req.headers.host||'').split(':')[0]))return send(res,403,{error:'无效的访问地址'});
    if(req.method==='POST'){
      if(req.headers['x-shiju-token']!==TOKEN)return send(res,403,{error:'页面连接已更新，请刷新页面'});
      const origin=req.headers.origin;if(origin&&!['http://127.0.0.1:'+PORT,'http://localhost:'+PORT].includes(origin))return send(res,403,{error:'请求来源无效'});
    }
    if(url.pathname==='/api/state'&&req.method==='GET')return send(res,200,publicState());
    if(url.pathname==='/api/media/state'&&req.method==='GET')return send(res,200,publicMedia(state,videoEngine.snapshot,videoEngine.error));
    if(['/api/media/file','/api/media/transcript','/api/media/transcript-file'].includes(url.pathname)&&['GET','HEAD'].includes(req.method)){
      const asset=state.mediaAssets.find(a=>a.id===url.searchParams.get('id'));if(!asset)return send(res,404,{error:'找不到视频素材。'});
      const version=asset.transcripts.find(t=>t.id===(url.searchParams.get('version')||asset.transcriptId));
      if(url.pathname==='/api/media/file'){
        const file=url.searchParams.has('version')?version?.videoFile:asset.file;if(!file)return send(res,404,{error:'视频尚未保存。'});
        return streamMedia(req,res,file);
      }
      if(!version)return send(res,404,{error:'口播文稿尚未完成。'});
      if(url.pathname==='/api/media/transcript')return send(res,200,{...version,title:asset.title,source:asset.url,author:asset.author});
      const format=url.searchParams.get('format');if(!['txt','srt','json'].includes(format))return send(res,400,{error:'不支持的文稿格式。'});
      let content;if(format==='txt')content=version.text+'\n';else if(format==='json')content=JSON.stringify(version,null,2);else{
        const stamp=ms=>{const n=Math.max(0,Math.round(ms));return [Math.floor(n/3600000),Math.floor(n/60000)%60,Math.floor(n/1000)%60].map(v=>String(v).padStart(2,'0')).join(':')+','+String(n%1000).padStart(3,'0')};
        content=version.segments.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text}\n`).join('\n');
      }
      res.writeHead(200,{'Content-Type':format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="transcript.${format}"; filename*=UTF-8''${encodeURIComponent((asset.title||'视频')+'.口播.'+format)}`,'Cache-Control':'no-store'});res.end(content);return;
    }
    if(url.pathname==='/api/media/intake'&&req.method==='POST'){
      const body=await readBody(req);if(body.topicId)getTopic(body.topicId);
      const result=await videoEngine.request('jobs',{text:body.text,force:body.force===true});
      const snapshot=await videoEngine.request('state');await synchronizeMedia(snapshot);videoEngine.snapshot=snapshot;
      await serial(async()=>{if(body.topicId)for(const id of result.jobIds||[]){const asset=state.mediaAssets.find(a=>a.jobIds.includes(id));if(asset)attachMedia(asset,body.topicId)}await persist()});
      await videoEngine.refresh();return send(res,200,{...result,state:publicState()});
    }
    if(url.pathname==='/api/media/attach'&&req.method==='POST'){
      const body=await readBody(req);return await serial(async()=>{
        getTopic(body.topicId);const asset=state.mediaAssets.find(a=>a.id===body.id);if(!asset)return send(res,404,{error:'找不到视频素材。'});
        attachMedia(asset,body.topicId);const result=importMediaDocument(state,asset,body.topicId,{transcriptId:body.transcriptId||asset.transcriptId,explicit:true});
        if(result.created){await saveArchive(getTopic(body.topicId),{automatic:true});scheduleSync()}else await persist();
        send(res,200,{...result,state:publicState()});
      });
    }
    if(url.pathname==='/api/media/control'&&req.method==='POST'){
      const body=await readBody(req),allowed=['transcription-choice','retry','cancel','pause','settings','reveal','folder','access','cancel-transcription','transcribe','open-transcript'];
      if(!allowed.includes(body.command))return send(res,400,{error:'未知的视频操作。'});
      const asset=state.mediaAssets.find(a=>a.id===body.id);
      if(!['pause','settings','folder'].includes(body.command)&&!asset)return send(res,404,{error:'找不到视频素材。'});
      const payload={...(body.payload||{}),...(asset?{id:asset.jobId}:{})};
      const result=await videoEngine.request(body.command,payload);await videoEngine.refresh();return send(res,200,result);
    }
    if(url.pathname==='/api/action'&&req.method==='POST'){const b=await readBody(req);const result=await action(b);send(res,200,{...result,state:publicState()});if(['round.save','final.save','topic.delete','topic.restore'].includes(b.type))void syncPending();return;}
    if(url.pathname==='/api/analyze'&&req.method==='POST'){const b=await readBody(req);return send(res,202,await analysisService.start(b.topicId));}
    if(url.pathname==='/api/analysis/cancel'&&req.method==='POST'){const b=await readBody(req);return send(res,200,await analysisService.cancel(b.jobId));}
    if(url.pathname.startsWith('/api/jobs/')&&req.method==='GET'){const job=analysisService.jobs.get(url.pathname.split('/').pop());return send(res,job?200:404,job||{error:'任务不存在'});}
    if(url.pathname==='/api/connections/refresh'&&req.method==='POST'){await refreshStatus();return send(res,200,publicState());}
    if(url.pathname==='/api/feishu/sync'&&req.method==='POST'){await serial(()=>refreshArchives({force:true}));clearTimeout(syncTimer);void syncPending();return send(res,202,{message:'正在同步当前原文、评分、精选与已确认定稿'});}
    if(url.pathname==='/api/feishu/setup'&&req.method==='POST'){await feishu.setup();await refreshStatus();void syncPending();return send(res,200,publicState());}
    if(url.pathname==='/api/feishu/connect'&&req.method==='POST'){
      if(authFlow&&authFlow.expiresAt>Date.now())return send(res,200,{url:authFlow.url,qr:'/api/feishu/qrcode',expiresAt:authFlow.expiresAt});
      const result=await feishu.cli(['auth','login','--domain','base','--no-wait','--json']);
      const url=findAuthValue(result,['verification_url','verification_uri_complete','verification_uri']),device=findAuthValue(result,['device_code']);
      if(!url||!device)throw new Error('飞书没有返回授权地址');
      await feishu.cli(['auth','qrcode',url,'--output','feishu-authorization.png']);
      authFlow={url,device,expiresAt:Date.now()+((findAuthValue(result,['expires_in'])||600)*1000)};
      await writeFile(path.join(DATA,'auth-pending.json'),JSON.stringify(authFlow),{mode:0o600});
      return send(res,200,{url,qr:'/api/feishu/qrcode',expiresAt:authFlow.expiresAt});
    }
    if(url.pathname==='/api/feishu/qrcode'&&req.method==='GET'){const png=await readFile(path.join(DATA,'feishu-authorization.png'));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(png);return;}
    if(url.pathname==='/api/feishu/complete'&&req.method==='POST'){
      const existingLogin=await feishu.status();
      if(existingLogin.available){authFlow=null;await feishu.setup();await refreshStatus();void syncPending();return send(res,200,publicState());}
      if(!authFlow){try{authFlow=JSON.parse(await readFile(path.join(DATA,'auth-pending.json'),'utf8'));}catch{throw new Error('请先发起飞书授权');}}
      if(authFlow.expiresAt<Date.now())throw new Error('授权链接已过期，请重新发起');
      await feishu.cli(['auth','login','--device-code',authFlow.device,'--json'],25000);authFlow=null;await refreshStatus();await feishu.setup();await refreshStatus();void syncPending();return send(res,200,publicState());
    }
    if(url.pathname==='/api/backup'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="shiju-backup-${new Date().toISOString().slice(0,10)}.json"`});res.end(JSON.stringify(state,null,2));return;}
    if(url.pathname==='/api/health')return send(res,200,{ok:true,app:'shiju-workbench',version:'2.0.0'});
    if(req.method!=='GET')return send(res,404,{error:'接口不存在'});
    const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/media.js':'media.js','/style.css':'style.css','/media.css':'media.css','/favicon.svg':'favicon.svg','/video-intake.mjs':'../video-engine/public/intake.mjs','/platforms.mjs':'../video-engine/platforms.mjs'};
    const filename=files[url.pathname];if(!filename)return send(res,404,{error:'页面不存在'});
    const ext=path.extname(filename),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||(ext==='.mjs'?'text/javascript; charset=utf-8':undefined),'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(await readFile(path.join(ROOT,'dist',filename)));
  }catch(e){console.error(new Date().toISOString(),e.message);send(res,400,{error:e.message});}
});
function findAuthValue(o,keys){if(!o||typeof o!=='object')return null;for(const k of keys)if(o[k])return o[k];for(const v of Object.values(o)){const r=findAuthValue(v,keys);if(r)return r;}return null;}
await refreshArchives();
server.listen(PORT,'127.0.0.1',()=>console.log(`拾句 · 文案挑选台 http://127.0.0.1:${PORT}`));
videoEngine.start();
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;clearTimeout(syncTimer);const deadline=setTimeout(()=>process.exit(0),5000);deadline.unref();
  try{await videoEngine.stop();const job=analysisService.active;if(job){if(job.status==='running')await analysisService.cancel(job.id);await analysisService.wait(job.id);job.status='interrupted';job.message='服务已停止，已完成的结果已保留，可以继续分析剩余部分。';await analysisService.save(job);}}finally{await queue;server.close(()=>process.exit(0));}
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
if(state.archives.some(a=>a.sync.status!=='synced'))void syncPending();
