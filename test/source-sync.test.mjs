import test from 'node:test';
import assert from 'node:assert/strict';
import {topicOf,selectFragment} from '../lib/model.mjs';
import {updateDocument,reconcileLegacySelections,removeDocument,restoreDocument} from '../lib/source-sync.mjs';
const make=()=>topicOf({title:'同步',documents:[{title:'原稿',text:'开头。\n\n原来的正文。\n\n结尾。'}]});
test('修改原段落同步精选和原样引用的组稿，保留ID顺序备注与已确认定稿',()=>{
 const t=make(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:1,note:'保留细节'});const id=t.selections[0].id;
 t.draft='我的引言\n\n原来的正文。\n\n我的结尾';t.finalDraft={text:t.draft};const final=structuredClone(t.finalDraft);
 const result=updateDocument(t,d.id,{...d,title:'新标题',text:'开头。\n\n改好的正文。\n\n结尾。'});
 assert.equal(t.selections[0].id,id);assert.equal(t.selections[0].text,'改好的正文。');assert.equal(t.selections[0].documentTitle,'新标题');assert.equal(t.selections[0].note,'保留细节');assert.equal(t.draft,'我的引言\n\n改好的正文。\n\n我的结尾');assert.deepEqual(t.finalDraft,final);assert.equal(result.draftUpdates,1);assert.equal(t.documentHistory.length,1);
});
test('前插段落与原段落换位后仍关联原内容，整篇重写不按序号错配',()=>{
 const t=make(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:1});
 updateDocument(t,d.id,{...d,text:'新引子。\n\n结尾。\n\n原来的正文。\n\n开头。'});assert.equal(t.selections[0].paragraphIndex,2);
 updateDocument(t,d.id,{...d,text:'完全不同的主题。\n\n另一件事。'});assert.equal(t.selections.length,0);assert.equal(t.previousSelections[0].text,'原来的正文。');
});
test('句子内局部修改同步，手动改写的组稿保留并提示核对',()=>{
 const t=make(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:1,kind:'sentence',start:0,end:6});t.draft='我重新写的正文。';
 updateDocument(t,d.id,{...d,text:'开头。\n\n原来的新正文。\n\n结尾。'});assert.equal(t.selections[0].text,'原来的新正文。');assert.equal(t.draft,'我重新写的正文。');assert.equal(t.sourceSync.draftReview,true);
});
test('删除可恢复关联精选，组稿不会因删参考稿消失',()=>{
 const t=make(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:1});t.draft='已编辑稿件';const selected=structuredClone(t.selections);
 removeDocument(t,d.id);assert.equal(t.documents.length,0);assert.equal(t.selections.length,0);assert.equal(t.draft,'已编辑稿件');restoreDocument(t,d.id);assert.equal(t.documents[0].id,d.id);assert.deepEqual(t.selections,selected);assert.equal(t.removedDocuments.length,0);
});
test('历史数据只迁移一次，能对应的重新关联，旧内容可找回，草稿保持原样',()=>{
 const t=make(),d=t.documents[0];selectFragment(t,{documentId:d.id,paragraphIndex:0});selectFragment(t,{documentId:d.id,paragraphIndex:1});d.text='新引言\n\n开头。';t.draft='手写的组稿';
 assert.equal(reconcileLegacySelections(t),true);assert.equal(t.selections.length,1);assert.equal(t.selections[0].paragraphIndex,1);assert.equal(t.previousSelections.length,1);assert.equal(t.draft,'手写的组稿');assert.equal(reconcileLegacySelections(t),false);assert.equal(t.previousSelections.length,1);
});

test('仅改标题不会丢失重复段落或重复句子的选择',()=>{
 const t=topicOf({title:'重复内容',documents:[{title:'旧标题',text:'相同段落。\n\n相同段落。\n\n你好，你好。'}]}),d=t.documents[0];
 selectFragment(t,{documentId:d.id,paragraphIndex:1});selectFragment(t,{documentId:d.id,paragraphIndex:2,kind:'sentence',start:0,end:2});
 updateDocument(t,d.id,{...d,title:'新标题'});assert.equal(t.selections.length,2);assert.equal(t.selections[0].paragraphIndex,1);assert.equal(t.selections[1].start,0);assert.equal(t.selections[1].text,'你好');
});
