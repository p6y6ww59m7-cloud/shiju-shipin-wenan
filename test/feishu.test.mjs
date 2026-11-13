import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Feishu} from '../lib/feishu.mjs';
import {topicOf,archiveOf} from '../lib/model.mjs';

test('飞书真实同步链路在部分写入失败后重试仍复用记录，删除恢复不新增',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'shiju-feishu-'));await mkdir(path.join(root,'data'));
 const f=new Feishu(root);f.config={baseToken:'base',archiveTableId:'archives',referenceTableId:'finals',sourceTableId:'sources'};f.setup=async()=>{};
 const tables=new Map(['archives','finals','sources'].map(t=>[t,new Map()]));let next=0,failFinal=true;
 f.cli=async args=>{
   const value=flag=>args[args.indexOf(flag)+1],table=tables.get(value('--table-id')),command=args[1];
   if(command==='+record-list'){
     const [,op,key]=JSON.parse(value('--filter-json')).conditions[0],matched=[...table.values()].filter(row=>op==='=='?row['记录编号']===key:row['记录编号'].includes(key));
     const offset=Number(value('--offset')),page=matched.slice(offset,offset+1); // Exercise pagination, including detached rows.
     await writeFile(path.join(root,value('--output')),page.map(JSON.stringify).join('\n'));return {has_more:offset+page.length<matched.length};
   }
   if(value('--table-id')==='finals'&&failFinal){failFinal=false;throw new Error('模拟暂时断网');}
   const payload=JSON.parse(await readFile(path.join(root,value('--json').slice(1)),'utf8'));
   if(command==='+record-batch-create'){const ids=[];for(const fields of payload.create_records){const record_id='rec'+(++next);table.set(record_id,{record_id,...fields});ids.push(record_id);}return {record_id_list:ids};}
   if(command==='+record-batch-update'){for(const [id,fields]of Object.entries(payload.update_records)){assert.ok(table.has(id));table.set(id,{...table.get(id),...fields});}return {};}
   throw new Error('unexpected command '+command);
 };
 const t=topicOf({title:'同一个选题',documents:[{title:'甲',text:'甲文案。'},{title:'乙',text:'乙文案。'}]});t.finalDraft={text:'确认的最终稿',confirmedAt:'2026-11-12T00:00:00Z'};
 try{
   await assert.rejects(f.sync(archiveOf(t)),/断网/);assert.equal(tables.get('archives').size,1);
   await f.sync(archiveOf(t));const ids=[...tables.values()].flatMap(table=>[...table.keys()]);
   await f.sync(archiveOf(t));assert.deepEqual([...tables.values()].flatMap(table=>[...table.keys()]),ids);
   const removed=t.documents.pop();await f.sync(archiveOf(t));const row=[...tables.get('sources').values()].find(r=>r['记录编号'].endsWith(removed.id));assert.equal(row['档案状态'],'已删除');assert.deepEqual(row['所属选题'],[]);
   t.documents.push(removed);t.title='修改选题标题';await f.sync(archiveOf(t));assert.deepEqual([...tables.values()].flatMap(table=>[...table.keys()]),ids);assert.equal(tables.get('sources').get(row.record_id)['档案状态'],'正常');
   assert.equal([...tables.get('archives').values()][0]['选题'],'修改选题标题');assert.equal([...tables.get('finals').values()][0]['最终文稿'],'确认的最终稿');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('飞书读取分页状态异常时停止，不能误判记录不存在后重复新增',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'shiju-feishu-incomplete-'));await mkdir(path.join(root,'data'));const f=new Feishu(root);f.config={baseToken:'base'};let writes=0;
 f.cli=async args=>{if(args[1]!=='+record-list'){writes++;return {};}await writeFile(path.join(root,args[args.indexOf('--output')+1]),'');return {};};
 try{await assert.rejects(f.upsert('table','topic',{'记录编号':'topic'}),/分页状态不完整/);assert.equal(writes,0);}finally{await rm(root,{recursive:true,force:true});}
});
