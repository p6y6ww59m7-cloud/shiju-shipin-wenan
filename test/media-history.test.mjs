import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {restoreVideoHistory} from '../lib/video-engine.mjs';
import {reconcileMedia} from '../lib/media.mjs';

test('迁移备份包含每条原下载记录，分段临时资源和转写内存副本不进入记录',()=>{
  const state={topics:[]},jobs=[{id:'first',url:'https://youtu.be/same',created:1,status:'done',candidates:[{url:'private-cdn'}],transcriptDocument:{text:'duplicate-text'}},{id:'second',url:'https://youtube.com/watch?v=same',created:2,status:'done'}];
  reconcileMedia(state,{jobs});assert.equal(state.mediaAssets.length,1);assert.equal(state.mediaHistory.length,2);assert.deepEqual(state.mediaHistory[0].candidates,[]);assert.equal(state.mediaHistory[0].transcriptDocument,undefined);
  reconcileMedia(state,{jobs:[]});assert.equal(state.mediaHistory.length,2);
});

test('恢复时只补回缺失的下载历史，当前已有资料绝不覆盖',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiju-restore-history-')),file=path.join(dir,'history.json');
  try{
    const history=[{id:'old',url:'https://youtu.be/old'}];await restoreVideoHistory(dir,history);assert.deepEqual(JSON.parse(await readFile(file)),history);assert.equal((await stat(file)).mode&0o777,0o600);
    const current=[{id:'new',url:'https://youtu.be/new'}];await writeFile(file,JSON.stringify(current));await restoreVideoHistory(dir,history);assert.deepEqual(JSON.parse(await readFile(file)),current);
  }finally{await rm(dir,{recursive:true,force:true})}
});
