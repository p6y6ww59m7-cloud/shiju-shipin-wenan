import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAutoIntake, hasVideoLink } from '../public/intake.mjs';
import { downloadIssue, pageGate } from '../workflow.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('pasting auto-submits once; a second paste during submission is retained',async()=>{
  let text='https://youtu.be/first',release;const submitted=[];
  const intake=createAutoIntake({getText:()=>text,delay:5,submit:async value=>{submitted.push(value);if(submitted.length===1)await new Promise(r=>release=r);return {added:1}},accepted:value=>{if(text===value)text=''}});
  try{
    intake.schedule();intake.schedule();await delay(25);
    assert.deepEqual(submitted,['https://youtu.be/first']);
    text='https://b23.tv/second';intake.schedule();await delay(15);release();await delay(30);
    assert.deepEqual(submitted,['https://youtu.be/first','https://b23.tv/second']);assert.equal(text,'');
  }finally{intake.stop()}
});

test('unsupported input does not submit; failed input stays available for an explicit retry',async()=>{
  let text='说明 https://youtube.com.evil.test/watch?v=x',calls=0,errors=0;
  assert.equal(hasVideoLink(text),false);
  const intake=createAutoIntake({getText:()=>text,delay:5,submit:async()=>{if(++calls===1)throw new Error('offline');return {added:1}},failed:()=>errors++,accepted:()=>text=''});
  try{
    await intake.flush();assert.equal(calls,0);
    text='分享 https://v.kuaishou.com/abc/。';await intake.flush();await delay(15);
    assert.equal(errors,1);assert.equal(calls,1);assert.ok(text);
    await intake.flush();assert.equal(calls,2);assert.equal(text,'');
  }finally{intake.stop()}
});

test('login prompts require a visible gate rather than a navigation login link or an ordinary failure',()=>{
  assert.equal(pageGate({text:'首页 推荐 登录 精彩短视频',dialogs:[]}),null);
  assert.equal(pageGate({text:'登录后观看',dialogs:['扫码登录 验证码登录']}),'login');
  assert.equal(pageGate({text:'安全验证 请拖动滑块'}),'verification');
  assert.equal(pageGate({text:'普通视频',password:true}),'login');
  assert.equal(downloadIssue('HTTP Error 503: Service Unavailable'),'network');
  assert.equal(downloadIssue('This video is unavailable'),'unavailable');
  assert.equal(downloadIssue('Sign in to confirm you are not a bot'),'verification');
  assert.equal(downloadIssue('Login required, use --cookies'),'login');
  assert.equal(downloadIssue('missing ffmpeg'),'unknown');
});

test('new downloads never inherit automatic transcription; selection applies only to the chosen job',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'video-choice-test-'));
  await writeFile(path.join(dir,'settings.json'),JSON.stringify({autoTranscribe:true,proxy:'direct'}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,DOUYIN_EXPORT_DATA:dir,DOUYIN_EXPORT_OUTPUT:path.join(dir,'out')},stdio:['ignore','pipe','pipe']});
  let ready='',stderr='';child.stderr.on('data',b=>stderr+=b);
  try{
    const origin=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('server start timeout '+stderr)),10000);
      child.once('error',e=>{clearTimeout(timer);reject(e)});
      child.stdout.on('data',b=>{ready+=b;try{const d=JSON.parse(ready.trim());clearTimeout(timer);resolve(d.url)}catch{}});
    });
    const token=(await(await fetch(origin)).text()).match(/const token='([^']+)'/)[1];
    const api=async(route,body)=>{const r=await fetch(origin+'/api/'+route,{method:body?'POST':'GET',headers:{'x-session-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200,await r.clone().text());return r.json()};
    await api('pause',{paused:true});
    await api('jobs',{text:'https://youtu.be/first https://b23.tv/second',autoTranscribe:true});
    let s=await api('state');assert.deepEqual(s.jobs.map(j=>j.autoTranscribe),[false,false]);
    await api('transcription-choice',{id:s.jobs[1].id,enabled:true});
    s=await api('state');assert.deepEqual(s.jobs.map(j=>j.autoTranscribe),[false,true]);
    assert.ok(s.jobs.every(j=>!j.transcript));
    await api('transcription-choice',{id:s.jobs[1].id,enabled:false});
    s=await api('state');assert.ok(s.jobs.every(j=>!j.autoTranscribe));
  }finally{
    child.kill('SIGTERM');await once(child,'exit');await rm(dir,{recursive:true,force:true});
  }
});
