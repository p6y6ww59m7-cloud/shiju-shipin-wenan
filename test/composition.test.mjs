import test from 'node:test';
import assert from 'node:assert/strict';
import {moveSelection,appendDraft,insertDraft,cleanDraft,moveDraftParagraph} from '../lib/composition.mjs';
test('精选可跨多项移动到首尾或任意位置，其余内容保持相对顺序',()=>{
 const t={selections:['a','b','c','d','e'].map(id=>({id,text:id}))};
 moveSelection(t,{selectionId:'e',toIndex:0});assert.deepEqual(t.selections.map(s=>s.id),['e','a','b','c','d']);
 moveSelection(t,{selectionId:'a',afterId:'d'});assert.deepEqual(t.selections.map(s=>s.id),['e','b','c','d','a']);
 moveSelection(t,{selectionId:'a',beforeId:'c'});assert.deepEqual(t.selections.map(s=>s.id),['e','b','a','c','d']);
 const saved=JSON.stringify(t);assert.throws(()=>moveSelection(t,{selectionId:'a',toIndex:1.5}));assert.throws(()=>moveSelection(t,{selectionId:'missing',toIndex:0}));assert.equal(JSON.stringify(t),saved);
});
test('连续插入按选择顺序保留文稿前后内容，追加不累积空行',()=>{
 assert.equal(appendDraft('已有正文。\n\n\n  ','\n 新素材。 \n'),'已有正文。\n\n新素材。');
 assert.equal(appendDraft(' \n\n','首段'),'首段');
 const first=insertDraft('开头\n\n结尾','素材一',2);
 assert.equal(first,'开头\n\n素材一\n\n结尾');
 assert.equal(insertDraft(first,'素材二','开头\n\n素材一'.length),'开头\n\n素材一\n\n素材二\n\n结尾');
 assert.equal(insertDraft('原文','开场',0),'开场\n\n原文');
 assert.throws(()=>insertDraft('原文','新段',99));
});
test('整理空行不改句中文字，文稿可直接跨段移动',()=>{
 assert.equal(cleanDraft('  第一行\r\n第二行\r\n \t\r\n\r\n第三行\n\u3000\n\n结尾  '),'第一行\n第二行\n\n第三行\n\n结尾');
 assert.equal(moveDraftParagraph('第一段\n\n第二段\n\n第三段',2,0),'第三段\n\n第一段\n\n第二段');
 assert.equal(moveDraftParagraph('第一段\n\n第二段\n\n第三段',0,2),'第二段\n\n第三段\n\n第一段');
});
