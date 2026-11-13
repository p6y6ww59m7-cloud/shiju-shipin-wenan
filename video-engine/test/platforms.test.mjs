import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractLinks } from '../core.mjs';
import { platformFor, platformVideoId, playbackURL, kuaishouData } from '../platforms.mjs';
import { cookieText, runTool, downloadWithEngine,networkProxy } from '../downloader.mjs';

test('mixed share text supports five platforms, short links and rejects spoofed hosts and credentials', () => {
  const urls=extractLinks('视频 https://youtu.be/jNQXAC9IVRw。 https://www.bilibili.com/video/BV13x41117TL https://b23.tv/abc\nhttps://v.kuaishou.com/abc/ https://x.com/example/status/123 https://www.douyin.com/video/7476702588022623515 https://youtube.com.evil.test/x https://evil-youtube.com/a https://user:pass@youtube.com/watch?v=x https://youtu.be/jNQXAC9IVRw');
  assert.equal(urls.length,6);
  assert.deepEqual(urls.map(u=>platformFor(u).id),['youtube','bilibili','bilibili','kuaishou','twitter','douyin']);
  assert.equal(platformVideoId(urls[0]),'jNQXAC9IVRw');
  assert.equal(platformVideoId('https://youtube.com/shorts/Abcd_123'),'Abcd_123');
  assert.equal(platformVideoId('https://www.kuaishou.com/short-video/3x43cyvcyph57i4'),'3x43cyvcyph57i4');
  assert.equal(platformFor('https://youtube.com:9222/watch?v=x'),null);
});

test('Kuaishou matching excludes adjacent recommended photos', () => {
  const data={feed:[{photoId:'wrong',photoUrl:'https://cdn.test/wrong.mp4'},{photoId:'wanted',caption:'正确作品',videoResource:{url:'https://cdn.test/target.mp4'}}]};
  assert.deepEqual(kuaishouData(data,'wanted').map(c=>c.url),['https://cdn.test/target.mp4']);
  assert.deepEqual(kuaishouData(data,''),[]);
});

test('Douyin search and profile modals navigate to the requested work and preserve source identity', () => {
  const id='7476702588022623515', canonical=`https://www.douyin.com/video/${id}`;
  for (const url of [
    `https://www.douyin.com/user/self/search/example?aid=test&modal_id=${id}&type=general`,
    `https://www.douyin.com/jingxuan/search/example?modal_id=${id}`,
    `https://www.douyin.com/search/example?aweme_id=${id}`,
    `https://www.douyin.com/user/example?modal_id=${id}`,
    `https://www.iesdouyin.com/share/video/${id}/?source=test`
  ]) {
    assert.equal(playbackURL(url),canonical);
    assert.equal(platformVideoId(playbackURL(url)),platformVideoId(url));
  }
  assert.equal(playbackURL(`${canonical}?modal_id=1111111111111111111`),canonical);
});

test('playback routing keeps unresolved links and photo posts without inventing a video id', () => {
  for (const url of [
    'https://v.douyin.com/Example/',
    'https://www.douyin.com/search/example',
    'https://www.douyin.com/search/example?modal_id=not-a-video',
    'https://www.douyin.com/?modal_id=123%2F4567890123',
    'https://www.douyin.com/note/7476702588022623515',
    'https://www.douyin.com/slides/7476702588022623515',
    'https://www.youtube.com/watch?v=example',
    'https://www.bilibili.com/video/BV13x41117TL?p=2',
    'https://douyin.com.evil.test/?modal_id=7476702588022623515'
  ]) assert.equal(playbackURL(url),url);
});

test('cookie export preserves session cookies and drops injected rows', () => {
  const text=cookieText([{domain:'.youtube.com',path:'/',name:'session',value:'secret',secure:true,expires:-1},{domain:'x.com',name:'bad\nrow',value:'x'}]);
  assert.match(text,/\.youtube.com\tTRUE\t\/\tTRUE\t0\tsession\tsecret/);
  assert.doesNotMatch(text,/bad/);
});

test('explicit direct or custom network settings take priority over automatic route selection',async()=>{
  assert.equal(await networkProxy('direct','youtube'),'');
  assert.equal(await networkProxy('http://127.0.0.1:12345','youtube'),'http://127.0.0.1:12345/');
  await assert.rejects(networkProxy('file:///tmp/test','youtube'),/代理地址/);
});

test('subprocess reads chunked progress, reports extraction errors, and aborts promptly', async () => {
  const lines=[];
  await runTool(process.execPath,['-e',"process.stdout.write('PROG');setTimeout(()=>console.log('RESS:8:10'),20)"],{onLine:line=>lines.push(line)});
  assert.deepEqual(lines,['PROGRESS:8:10']);
  await assert.rejects(runTool(process.execPath,['-e',"console.error('ERROR: login required');process.exit(1)"]),/login required/);
  const controller=new AbortController();const before=Date.now();
  const promise=runTool(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(new Error('test cancelled')),30);
  await assert.rejects(promise,/test cancelled/);assert.ok(Date.now()-before<3000);
});

test('external download failure deletes credentials and all incomplete streams', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'platform-test-'));
  try {
    await assert.rejects(downloadWithEngine({root,outputDir:root,job:{url:'https://youtu.be/example'},cookies:[{domain:'.youtube.com',path:'/',name:'session',value:'secret'}],probe:async()=>({})}),/ENOENT/);
    assert.deepEqual(await readdir(root),[]);
  } finally {await rm(root,{recursive:true,force:true})}
});

test('missing fragments never publish a plausible-looking incomplete video',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fragment-abort-'));
  try{
    const vendor=path.join(root,'native/vendor'),outputDir=path.join(root,'out');await mkdir(vendor,{recursive:true});await mkdir(outputDir);
    await writeFile(path.join(vendor,'yt-dlp'),`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),dir=path.dirname(args[args.indexOf('--output')+1]);fs.writeFileSync(path.join(dir,'source.mp4'),Buffer.alloc(4096));fs.writeFileSync(path.join(dir,'source.info.json'),JSON.stringify({duration:20,title:'incomplete'}));console.error('ERROR: fragment missing');process.exit(1);\n`,{mode:0o755});
    let probed=false;
    await assert.rejects(downloadWithEngine({root,outputDir,job:{url:'https://youtube.com/watch?v=example'},probe:async()=>{probed=true;return {duration:20}}}),/fragment missing/);
    assert.equal(probed,false);assert.deepEqual(await readdir(outputDir),[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('split-stream publication validates duration, preserves collisions and aborts before publishing', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'platform-publish-'));
  try {
    const vendor=path.join(root,'native/vendor'), outputDir=path.join(root,'out');
    await mkdir(vendor,{recursive:true});await mkdir(outputDir);
    await writeFile(path.join(vendor,'yt-dlp'),`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),dir=path.dirname(args[args.indexOf('--output')+1]);const b=Buffer.alloc(2048);b.write('ftypisom',4);fs.writeFileSync(path.join(dir,'source.mp4'),b);fs.writeFileSync(path.join(dir,'source.info.json'),JSON.stringify({title:'example',id:'one',duration:20,acodec:'aac'}));\n`,{mode:0o755});
    const options={root,outputDir,job:{url:'https://youtu.be/example'},probe:async()=>({duration:20,videoTracks:1,audioTracks:1})};
    const first=await downloadWithEngine(options), second=await downloadWithEngine(options);
    assert.notEqual(first.file,second.file);assert.equal((await readFile(first.file)).length,2048);
    await assert.rejects(downloadWithEngine({...options,probe:async()=>({duration:5,videoTracks:1,audioTracks:1})}),/不完整/);
    const controller=new AbortController();
    await assert.rejects(downloadWithEngine({...options,signal:controller.signal,probe:async()=>{controller.abort();return {duration:20,audioTracks:1}}}));
    assert.deepEqual((await readdir(outputDir)).sort(),['example_one (2).mp4','example_one.mp4']);
  } finally {await rm(root,{recursive:true,force:true})}
});
