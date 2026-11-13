import test from 'node:test';
import assert from 'node:assert/strict';
import {topicOf,selectFragment,archiveOf} from '../lib/model.mjs';
import {referenceFields} from '../lib/reference.mjs';
import {Feishu} from '../lib/feishu.mjs';
import {validateReview} from '../lib/quick-review.mjs';
function sample(){
 const t=topicOf({title:'同一个故事',documents:[{title:'第一篇',text:'开头一句话。\n\n事情的经过。'},{title:'第二篇',text:'另一种开头。\n\n另一种结尾。'}]});
 const d=t.documents[0];t.analysis={documents:[{documentId:d.id,score:84,summary:'表达具体',dimensions:[{name:'清晰度',score:84,reason:'过程容易理解'}],paragraphs:[{index:0,label:'recommend',reason:'先说矛盾，有吸引力'},{index:1,label:'neutral',reason:'叙述过程清楚'}]}]};return t;
}
test('精简评阅同步完整原文，普通段落不误报未分析，保留不建议用标签',()=>{
 const t=sample();t.analysis=validateReview(t,{comparison:'比较结论',documents:t.documents.map((d,index)=>({index,score:60,summary:'结构清楚，开场需优化',marks:[{start:0,end:0,label:'skip',reason:'开场不属于正文'}]}))});
 const f=referenceFields(t,t.documents[0],'rec-topic');assert.equal(f['原始文案'],t.documents[0].text);assert.match(f['段落分析'],/不建议用：开场不属于正文/);assert.match(f['段落分析'],/未标记重点；可自行选择/);assert.ok(!f['段落分析'].includes('尚未分析'));assert.ok(!f['维度评分'].includes('尚未分析'));
});
test('每篇参考原文含独立评分、逐段分析和确切选择，个人理由不冒充 AI 理由',()=>{
 const t=sample(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:1,note:'我想保留事情经过'});
 const f=referenceFields(t,d,'rec-topic');assert.equal(f['整体评分'],84);assert.equal(f['原始文案'],d.text);
 assert.match(f['段落分析'],/第 1 段 · 未选择/);assert.match(f['段落分析'],/第 2 段 · ✓ 已选整段/);
 assert.match(f['我的选择'],/第 2 段/);assert.match(f['选择理由'],/我的理由：我想保留事情经过/);assert.match(f['选择理由'],/分析建议：叙述过程清楚/);
 assert.ok(!f['选择理由'].includes('先说矛盾'));
});
test('选择句子与修改前的旧选择可区分，不会把新原文误标成已选',()=>{
 const t=sample(),d=t.documents[0];selectFragment(t,{documentId:d.id,kind:'sentence',paragraphIndex:0,start:0,end:2});
 let f=referenceFields(t,d,'rec-topic');assert.match(f['段落分析'],/第 1 段 · ✓ 已选其中句子/);assert.match(f['我的选择'],/开头/);
 d.text='改写后的开头。\n\n事情的经过。';f=referenceFields(t,d,'rec-topic');assert.match(f['我的选择'],/原稿修改前的选择/);assert.match(f['段落分析'],/第 1 段 · 未选择/);assert.ok(!f['选择理由'].includes('分析建议'));
});
test('反复同步更新同一参考条目，父档案保持一个，定稿与逐篇原文分开',async()=>{
 const t=sample();t.finalDraft={text:'这是定稿',confirmedAt:'2026-11-11T00:00:00Z'};const f=new Feishu('/tmp');f.config={archiveTableId:'archives',referenceTableId:'finals',sourceTableId:'references',url:'https://example.com'};f.setup=async()=>{};
 const records=new Map();f.upsert=async(table,key,fields,knownId)=>{const address=table+':'+key,old=records.get(address);const id=old?.id||knownId||'rec'+records.size;records.set(address,{id,...old,...fields});return id;};
 f.records=async(table)=>[...records.entries()].filter(([address])=>address.startsWith(table+':')).map(([,row])=>row);
 await f.sync(archiveOf(t,[]));selectFragment(t,{documentId:t.documents[0].id,paragraphIndex:0});await f.sync(archiveOf(t,[]));
 assert.equal(records.size,4);const archive=records.get('archives:'+t.id);assert.equal(archive['参考原文'].length,2);assert.equal(archive['最终稿'],'这是定稿');assert.ok(!('分析模型' in archive));assert.ok(!('历次保存' in archive));
 const reference=records.get('references:'+t.id+':'+t.documents[0].id);assert.match(reference['我的选择'],/第 1 段/);
 const removed=t.documents.pop(),removedKey='references:'+t.id+':'+removed.id,removedId=records.get(removedKey).id;
 t.analysis=null;await f.sync(archiveOf(t,[]));assert.equal(records.size,4);assert.equal(records.get(removedKey)['档案状态'],'已删除');assert.deepEqual(records.get(removedKey)['所属选题'],[]);assert.equal(records.get('archives:'+t.id)['参考原文'].length,1);assert.equal(records.get('references:'+t.id+':'+t.documents[0].id)['整体评分'],null);
 t.documents.push(removed);await f.sync(archiveOf(t,[]));assert.equal(records.size,4);assert.equal(records.get(removedKey).id,removedId);assert.equal(records.get(removedKey)['档案状态'],'正常');assert.equal(records.get('archives:'+t.id)['参考原文'].length,2);
 t.documents=[];await f.sync(archiveOf(t,[]));assert.equal(records.size,4);assert.deepEqual(records.get('archives:'+t.id)['参考原文'],[]);assert.equal(records.get('finals:'+t.id)['最终文稿'],'这是定稿');
 t.documents=[removed];await f.sync(archiveOf(t,[]));
 const deleted=archiveOf(t,[]);deleted.deletedAt='2026-11-11T00:00:00Z';await f.sync(deleted);assert.equal(records.get('references:'+t.id+':'+t.documents[0].id)['档案状态'],'已删除');assert.equal(records.size,4);
});
