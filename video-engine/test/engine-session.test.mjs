import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('two desktop entries share one engine and a protected session; owner exit preserves history',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'video-single-owner-')),children=[];
  async function start(){
    const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',DOUYIN_EXPORT_DATA:dir,DOUYIN_EXPORT_OUTPUT:path.join(dir,'out')},stdio:['ignore','pipe','pipe']});children.push(child);
    return new Promise((resolve,reject)=>{let buffer='',error='';const timer=setTimeout(()=>reject(new Error(error||'startup timeout')),10000);child.stderr.on('data',b=>error+=b);child.stdout.on('data',b=>{buffer+=b;try{const value=JSON.parse(buffer.trim());clearTimeout(timer);resolve({child,...value})}catch{}});child.once('error',reject)});
  }
  try{
    const first=await start(),session=JSON.parse(await readFile(path.join(dir,'engine-session.json'),'utf8'));
    assert.equal((await stat(path.join(dir,'engine-session.json'))).mode&0o777,0o600);
    const headers={'Content-Type':'application/json','x-session-token':session.token};
    await fetch(first.url+'/api/pause',{method:'POST',headers,body:'{"paused":true}'});
    await fetch(first.url+'/api/jobs',{method:'POST',headers,body:'{"text":"https://youtu.be/owner-test"}'});
    const second=await start();assert.equal(second.reused,true);assert.equal(second.url,first.url);assert.equal(second.pid,first.pid);
    if(second.child.exitCode===null)await once(second.child,'exit');
    assert.equal((await(await fetch(first.url+'/api/state',{headers})).json()).jobs.length,1);
    first.child.kill('SIGTERM');await once(first.child,'exit');assert.equal(JSON.parse(await readFile(path.join(dir,'history.json'),'utf8')).length,1);
    await assert.rejects(readFile(path.join(dir,'engine-session.json')),{code:'ENOENT'});
    const third=await start();assert.notEqual(third.pid,first.pid);third.child.kill('SIGTERM');await once(third.child,'exit');
  }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await rm(dir,{recursive:true,force:true})}
});
