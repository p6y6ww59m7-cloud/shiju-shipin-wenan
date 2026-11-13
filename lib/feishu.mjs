import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {run,parseJSON} from './process.mjs';
import {referenceFields,sourceFields} from './reference.mjs';
const archiveFields=[['选题','text'],['记录编号','text'],['选题编号','text'],['轮次','number'],['保存时间','datetime'],['用途','text'],['目标受众','text'],['文案数量','number'],['精选数量','number'],['横向对比结论','text'],['我的精选','text'],['最终稿','text'],['我的备注','text'],['历史操作','text'],['档案状态','text'],['定稿时间','text']].map(([name,type])=>({name,type}));
export function findValue(obj,keys) {
  if(!obj||typeof obj!=='object')return null;
  for(const key of keys)if(obj[key]!==undefined&&obj[key]!==null)return obj[key];
  for(const value of Object.values(obj)){const found=findValue(value,keys);if(found!==null)return found;}return null;
}
export class Feishu {
  constructor(root,dataDir){this.root=dataDir||root;this.filePrefix=dataDir?'':'data';this.configPath=path.join(dataDir||path.join(root,'data'),'feishu.json');this.config={};this.schemaVerified=false;this.lastError='';}
  async init(){try{this.config=JSON.parse(await readFile(this.configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  async persist(){const tmp=this.configPath+'.tmp';await writeFile(tmp,JSON.stringify(this.config,null,2),{mode:0o600});await rename(tmp,this.configPath);}
  async cli(args,timeout=60000){
    const result=await run(process.env.LARK_CLI||'lark-cli',args,{cwd:this.root,timeout});
    const json=parseJSON(result.code===0?result.stdout:result.stderr)||parseJSON(result.stdout);
    if(result.code!==0||json?.ok===false){const error=new Error(json?.error?.message|| (result.timedOut?'飞书请求超时，可稍后重试':result.stderr.slice(-1400)||'飞书命令执行失败'));error.detail=json?.error;throw error;}
    return json;
  }
  async status(){
    try{const status=await this.cli(['auth','status','--json']);return {available:!!status.identities?.user?.available,baseUrl:this.config.url||null,configured:!!this.config.referenceTableId,lastError:this.lastError};}
    catch(e){return {available:false,configured:false,baseUrl:this.config.url||null,lastError:e.message};}
  }
  setup(){
    if(!this.setupPromise)this.setupPromise=this.setupOnce().finally(()=>{this.setupPromise=null;});
    return this.setupPromise;
  }
  async setupOnce(){
    const status=await this.status();if(!status.available)throw new Error('飞书尚未授权，请先在「连接设置」中完成授权');
    if(!this.config.baseToken){
      const r=await this.cli(['base','+base-create','--name','文案选稿档案 · 拾句','--time-zone','Asia/Shanghai','--table-name','选题档案','--fields',JSON.stringify(archiveFields),'--as','user']);
      const token=findValue(r.data||r,['base_token','app_token']);if(typeof token!=='string')throw new Error('飞书已响应创建请求，但未返回多维表格标识；请检查后再继续，避免重复创建');
      this.config.baseToken=token;this.config.url=findValue(r.data||r,['url','base_url'])||`https://my.feishu.cn/base/${token}`;
      this.config.archiveTableId=findValue(r.data||r,['table_id']);await this.persist();
    }
    if(!this.config.archiveTableId){
      const r=await this.cli(['base','+table-list','--base-token',this.config.baseToken,'--as','user']);
      const search=(v)=>{if(!v||typeof v!=='object')return null;if(v.name==='选题档案'&&(v.table_id||v.id))return v.table_id||v.id;for(const x of Object.values(v)){const id=search(x);if(id)return id;}return null;};
      this.config.archiveTableId=search(r);if(!this.config.archiveTableId)throw new Error('未找到选题档案表，请检查飞书多维表格');await this.persist();
    }
    if(!this.config.referenceTableId){
      const listed=await this.cli(['base','+table-list','--base-token',this.config.baseToken,'--as','user']);
      const existing=listed.data?.tables?.find(t=>t.name==='最终定稿');
      if(existing){this.config.referenceTableId=existing.table_id||existing.id;await this.persist();}
    }
    if(!this.config.referenceTableId){
      const fields=[{name:'选题',type:'text'},{name:'记录编号',type:'text'},{name:'所属选题',type:'link',link_table:this.config.archiveTableId,bidirectional:true,bidirectional_link_field_name:'最终定稿'},...['最终文稿','选题编号','档案状态','定稿时间','更新说明'].map(name=>({name,type:'text'}))];
      const r=await this.cli(['base','+table-create','--base-token',this.config.baseToken,'--name','最终定稿','--fields',JSON.stringify(fields),'--as','user']);
      this.config.referenceTableId=findValue(r.data||r,['table_id','id']);if(!String(this.config.referenceTableId||'').startsWith('tbl')){this.config.referenceTableId=null;throw new Error('最终定稿表的标识未返回，请检查表格后继续');}await this.persist();
    }
    if(!this.config.sourceTableId){
      const listed=await this.cli(['base','+table-list','--base-token',this.config.baseToken,'--as','user']);
      const existing=listed.data?.tables?.find(t=>t.name==='参考原文');
      if(existing)this.config.sourceTableId=existing.table_id||existing.id;
      else{
        const created=await this.cli(['base','+table-create','--base-token',this.config.baseToken,'--name','参考原文','--fields',JSON.stringify(sourceFields(this.config.archiveTableId)),'--as','user']);
        this.config.sourceTableId=findValue(created.data||created,['table_id','id']);
      }
      if(!String(this.config.sourceTableId||'').startsWith('tbl'))throw new Error('参考原文表标识未返回');
      await this.persist();
      const views=await this.cli(['base','+view-list','--base-token',this.config.baseToken,'--table-id',this.config.sourceTableId,'--as','user']);
      for(const view of views.data?.views||[])await this.cli(['base','+view-set-filter','--base-token',this.config.baseToken,'--table-id',this.config.sourceTableId,'--view-id',view.id,'--json',JSON.stringify({logic:'and',conditions:[['档案状态','==','正常']]}),'--as','user']);
    }
    if(!this.schemaVerified){
      for(const id of [this.config.archiveTableId,this.config.referenceTableId,this.config.sourceTableId]){
        const r=await this.cli(['base','+field-list','--base-token',this.config.baseToken,'--table-id',id,'--as','user']);
        if(!JSON.stringify(r).includes('记录编号'))throw new Error('飞书字段校验失败：缺少记录编号');
      }this.schemaVerified=true;
    }
    return this.config;
  }
  async records(tableId,fields,filter){
    const rows=[];let offset=0;
    while(true){const filename=path.join(this.filePrefix,`lookup-${randomUUID()}.ndjson`);
      try{
        const result=await this.cli(['base','+record-list','--base-token',this.config.baseToken,'--table-id',tableId,...fields.flatMap(name=>['--field-id',name]),'--filter-json',JSON.stringify(filter),'--offset',String(offset),'--format','ndjson','--output',filename,'--as','user']);
        const page=(await readFile(path.join(this.root,filename),'utf8')).split('\n').filter(Boolean).map(JSON.parse);rows.push(...page);
        if(result.has_more===false)break;
        if(result.has_more!==true||!page.length)throw new Error('飞书记录分页状态不完整，已停止写入，避免遗漏或重复');
        offset+=page.length;
      }finally{for(const suffix of ['.ndjson','.manifest.json','.ndjson.schema.json'])await unlink(path.join(this.root,filename.replace('.ndjson',suffix))).catch(()=>{});}
    }return rows;
  }
  async lookup(tableId,key){
    const rows=await this.records(tableId,['记录编号'],{logic:'and',conditions:[['记录编号','==',key]]});
    if(rows.length>1)throw new Error('发现重复的归档编号，请检查飞书记录');
    return rows[0]?.record_id||rows[0]?.id||null;
  }
  async upsert(tableId,key,fields,knownId=null){
    const existing=knownId||await this.lookup(tableId,key);
    const filename=path.join(this.filePrefix,`write-${randomUUID()}.json`);
    await writeFile(path.join(this.root,filename),JSON.stringify(existing?{update_records:{[existing]:fields}}:{create_records:[fields]}),{mode:0o600});
    try{
      const r=await this.cli(['base',existing?'+record-batch-update':'+record-batch-create','--base-token',this.config.baseToken,'--table-id',tableId,'--json','@'+filename,'--as','user']);
      const ids=findValue(r.data||r,['record_id_list','record_ids']);
      const id=existing||ids?.[0]||findValue(r.data||r,['record_id']);
      if(typeof id!=='string')throw new Error('飞书写入响应缺少记录标识；重试时会先查询记录，避免重复');return id;
    }finally{await unlink(path.join(this.root,filename)).catch(()=>{});}
  }
  async sync(archive){
    await this.setup();const t=archive.topic,key=t.id,final=t.finalDraft;
    const oldSources=await this.records(this.config.sourceTableId,['记录编号','档案状态','所属选题'],{logic:'and',conditions:[['记录编号','intersects',key+':']]});
    const sourceByKey=new Map();for(const row of oldSources){const sourceKey=row['记录编号'];if(!sourceKey?.startsWith(key+':'))continue;if(sourceByKey.has(sourceKey))throw new Error('发现重复的参考原文编号，已停止同步');sourceByKey.set(sourceKey,row);}
    const finalText=final?.text||'',status=archive.deletedAt?'已删除':'正常';
    const recordId=await this.upsert(this.config.archiveTableId,key,{'选题':t.title,'记录编号':key,'选题编号':key,'轮次':archive.round,'保存时间':archive.savedAt,'用途':`${t.format} · ${t.purpose}`,'目标受众':t.audience,'文案数量':t.documents.length,'精选数量':t.selections.length,'横向对比结论':t.analysis?.comparison||'尚未分析','我的精选':t.selections.map(s=>`【${s.documentTitle}】\n${s.text}${s.note?'\n备注：'+s.note:''}`).join('\n\n'),'最终稿':finalText,'我的备注':t.notes,'历史操作':(t.operations||[]).map(x=>`${x.at} · ${x.label}`).join('\n'),'档案状态':status,'定稿时间':final?.confirmedAt||''});
    await this.upsert(this.config.referenceTableId,key,{'选题':t.title,'记录编号':key,'选题编号':key,'所属选题':[{id:recordId}],'最终文稿':finalText,'档案状态':status,'定稿时间':final?.confirmedAt||'','更新说明':final?'用户确认的最终文稿；修改后再次点击「保存为最终稿」即可更新。':'尚未定稿，在工作台组稿后点击「保存为最终稿」。'});
    const referenceIds=[];
    for(const doc of t.documents){
      const fields=referenceFields(t,doc,recordId,status);
      const existing=sourceByKey.get(fields['记录编号']);
      referenceIds.push(await this.upsert(this.config.sourceTableId,fields['记录编号'],fields,existing?.record_id||existing?.id));
      sourceByKey.delete(fields['记录编号']);
    }
    // References removed from the workbench must also leave the current archive.
    // Keep their stable keys so restoring them updates the same rows later.
    for(const [sourceKey,row]of sourceByKey)if(row['档案状态']!=='已删除'||row['所属选题']?.length)await this.upsert(this.config.sourceTableId,sourceKey,{'档案状态':'已删除','所属选题':[]},row.record_id||row.id);
    await this.upsert(this.config.archiveTableId,key,{'参考原文':referenceIds.map(id=>({id}))},recordId);
    return {recordId,url:this.config.url};
  }
}
