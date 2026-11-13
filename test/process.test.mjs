import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../lib/process.mjs';
test('进程超时和取消都会快速结束等待',async()=>{
  const started=Date.now();const r=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:60});assert.equal(r.timedOut,true);assert.ok(Date.now()-started<3000);
  const c=new AbortController();const p=run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:10000,signal:c.signal});c.abort();assert.equal((await p).aborted,true);
});
test('父进程退出后，忽略软退出信号的子进程也会被清理',async()=>{
  const childScript="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parentScript=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
  const result=await run(process.execPath,['-e',parentScript],{timeout:300});const pid=Number(result.stdout.trim());assert.ok(pid>0);assert.equal(result.timedOut,true);
  let alive=true;for(let i=0;i<35&&alive;i++){await new Promise(r=>setTimeout(r,50));try{process.kill(pid,0);}catch{alive=false;}}
  assert.equal(alive,false,'取消后不应遗留仍在运行的 Codex 子进程');
});

test('关闭时限后允许等待完成，并仍支持手动取消',async()=>{
  const result=await run(process.execPath,['-e',"setTimeout(()=>console.log('complete'),80)"],{timeout:0});
  assert.equal(result.code,0);assert.equal(result.timedOut,false);assert.match(result.stdout,/complete/);
  const controller=new AbortController();
  const pending=run(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{timeout:0,signal:controller.signal,onOutput:()=>controller.abort()});
  const cancelled=await pending;assert.equal(cancelled.aborted,true);assert.equal(cancelled.timedOut,false);
});
