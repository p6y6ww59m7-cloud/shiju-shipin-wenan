import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractLinks, videoId, findVideoObjects, formatsFromObject, safeName, saveVideo, unusedPath } from '../core.mjs';

function video() { const b = Buffer.alloc(4096); b.writeUInt32BE(24, 0); b.write('ftypisom', 4); return b; }
async function tmp(fn) { const d = await mkdtemp(path.join(os.tmpdir(), 'douyin-export-test-')); try { return await fn(d); } finally { await rm(d,{recursive:true,force:true}); } }

test('extracts shared short links, trailing Chinese punctuation and rejects lookalike domains', () => {
  const links = extractLinks('7.16 复制打开抖音 https://v.douyin.com/AbC123/ ，看看这个！\nhttps://www.douyin.com/video/7476702588022623515。\nhttps://evil-douyin.com/a https://douyin.com.evil.test/a https://v.douyin.com/AbC123/');
  assert.deepEqual(links, ['https://v.douyin.com/AbC123/', 'https://www.douyin.com/video/7476702588022623515']);
  assert.equal(videoId('https://www.douyin.com/?modal_id=7476702588022623515'), '7476702588022623515');
});

test('never selects a prefetched adjacent video when matching the requested work', () => {
  const target = { aweme_id: '7476702588022623515', video: { play_addr: { url_list: ['https://v.example/target.mp4'] } } };
  const other = { aweme_id: '1111111111111111111', video: { play_addr: { url_list: ['https://v.example/other.mp4'] } } };
  assert.deepEqual(findVideoObjects({data:[other,target]}, '7476702588022623515'),[target]);
  assert.deepEqual(findVideoObjects({data:[other,target]}, ''),[]);
  assert.equal(formatsFromObject(target)[0].url, 'https://v.example/target.mp4');
});

test('safe filenames and numbered collision handling preserve existing exports', () => tmp(async dir => {
  assert.equal(safeName('../猫/狗:动作?'), '_猫_狗_动作_');
  const file = await unusedPath(dir, '测试');
  await saveVideo(new Response(video()),file);
  assert.equal(await unusedPath(dir,'测试'),path.join(dir,'测试 (2).mp4'));
}));

test('streams a full video to disk and atomically removes the partial', () => tmp(async dir => {
  const file=path.join(dir,'saved.mp4'),data=video();
  const saved=await saveVideo(new Response(data,{headers:{'content-length':String(data.length)}}),file);
  assert.equal(saved.bytes,data.length); assert.deepEqual(await readFile(file),data);
  assert.deepEqual(await readdir(dir),['saved.mp4']);
}));

test('rejects HTTP 206 fragments instead of reporting a partial clip as complete', () => tmp(async dir => {
  const response=new Response(video(),{status:206,headers:{'content-range':'bytes 0-4095/12000'}});
  await assert.rejects(saveVideo(response,path.join(dir,'bad.mp4')),/片段/);
  assert.deepEqual(await readdir(dir),[]);
}));

test('rejects HTML, short downloads and validator failures without leaving misleading files', () => tmp(async dir => {
  const file=path.join(dir,'bad.mp4');
  await assert.rejects(saveVideo(new Response('<html>need login</html>'),file),/不是完整/);
  await assert.rejects(saveVideo(new Response(video(),{headers:{'content-length':'8000'}}),file),/不完整/);
  await assert.rejects(saveVideo(new Response(video()),file,{validate:async()=>{throw new Error('invalid tracks')}}),/invalid tracks/);
  assert.deepEqual(await readdir(dir),[]);
}));

test('cancellation during final validation never publishes a finished video', () => tmp(async dir => {
  const controller=new AbortController(),file=path.join(dir,'cancelled.mp4');
  await assert.rejects(saveVideo(new Response(video()),file,{signal:controller.signal,validate:async()=>controller.abort()}));
  assert.deepEqual(await readdir(dir),[]);
}));
