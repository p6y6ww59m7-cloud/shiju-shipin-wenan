import test from 'node:test';
import assert from 'node:assert/strict';
import {topicOf,selectFragment,archiveOf} from '../lib/model.mjs';
const make=()=>topicOf({title:'同一个故事',purpose:'讲清楚发生了什么',documents:[{title:'版本A',text:'开场的一句话。\n\n事情发生的经过。\n\n最后的感想。'}]});
test('整段选择与取消不会改变原稿',()=>{const t=make(),raw=t.documents[0].text;selectFragment(t,{documentId:t.documents[0].id,paragraphIndex:1});assert.equal(t.selections[0].text,'事情发生的经过。');assert.equal(t.documents[0].text,raw);selectFragment(t,{documentId:t.documents[0].id,paragraphIndex:1});assert.equal(t.selections.length,0);});
test('句子按原始字符位置收藏，越界会拒绝',()=>{const t=make(),id=t.documents[0].id;selectFragment(t,{documentId:id,paragraphIndex:0,kind:'sentence',start:0,end:2});assert.equal(t.selections[0].text,'开场');assert.throws(()=>selectFragment(t,{documentId:id,paragraphIndex:0,kind:'sentence',start:0,end:1000}));});
test('存档保留当时的原稿、选择和最终稿',()=>{const t=make();selectFragment(t,{documentId:t.documents[0].id,kind:'document'});t.draft='这一轮的最终稿';const a=archiveOf(t,[]);t.documents[0].text='后来的原稿';t.selections[0].text='后来的选择';t.draft='后来的最终稿';assert.equal(a.topic.draft,'这一轮的最终稿');assert.equal(a.topic.selections[0].text,a.topic.documents[0].text);assert.notEqual(a.topic.documents[0].text,t.documents[0].text);assert.equal(archiveOf(t,[a]).round,2);});
test('原稿更新后可同时保留旧精选并选择新段落',()=>{const t=make(),id=t.documents[0].id;selectFragment(t,{documentId:id,paragraphIndex:0});t.documents[0].text='新的开场。\n\n事情发生的经过。';selectFragment(t,{documentId:id,paragraphIndex:0});assert.equal(t.selections.length,2);assert.equal(t.selections[0].text,'开场的一句话。');assert.equal(t.selections[1].text,'新的开场。');});

test('同一选题反复保存，只更新一个档案，旧版本完整保留',()=>{
  const t=make();t.draft='初稿';t.finalDraft={text:'已确认的定稿',confirmedAt:'2026-11-11T00:00:00Z'};
  const first=archiveOf(t,[]);t.draft='尚未确认的新修改';const second=archiveOf(t,[first]);
  assert.equal(first.id,second.id);assert.equal(second.id,t.id);assert.equal(second.history.length,2);
  assert.equal(second.history[0].topic.draft,'初稿');assert.equal(second.topic.finalDraft.text,'已确认的定稿');
  t.finalDraft.text='再修改';assert.equal(second.topic.finalDraft.text,'已确认的定稿');
});
test('迁移合并旧轮次并保留全部历史和最近非空定稿，重复迁移不变',async()=>{
  const {migrateArchives}=await import('../lib/model.mjs');const t=make();const d=structuredClone(t);
  const state={schemaVersion:1,topics:[t],archives:[{id:'old2',topicId:t.id,round:2,savedAt:'2026-11-11T02:00:00Z',topic:{...d,draft:''}},{id:'old1',topicId:t.id,round:1,savedAt:'2026-11-11T01:00:00Z',topic:{...d,draft:'第一版已保存的稿件'}}]};
  assert.equal(migrateArchives(state),true);assert.equal(state.archives.length,1);assert.equal(state.archives[0].history.length,2);
  assert.equal(state.archives[0].topic.finalDraft.text,'第一版已保存的稿件');assert.equal(state.topics[0].finalDraft.text,'第一版已保存的稿件');
  const snapshot=JSON.stringify(state);assert.equal(migrateArchives(state),false);assert.equal(JSON.stringify(state),snapshot);
});
