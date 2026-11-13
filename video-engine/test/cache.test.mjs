import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sourceKey,savedVideo} from '../cache.mjs';

test('repeated links identify the same video without confusing Bilibili parts or tweet clips',()=>{
  assert.equal(sourceKey('https://youtu.be/fs6rjGfPaXg'),sourceKey('https://www.youtube.com/watch?v=fs6rjGfPaXg&list=RDfs6rjGfPaXg&start_radio=1'));
  assert.notEqual(sourceKey('https://bilibili.com/video/BV13x41117TL?p=1'),sourceKey('https://bilibili.com/video/BV13x41117TL?p=2'));
  assert.notEqual(sourceKey('https://x.com/a/status/123/video/1'),sourceKey('https://twitter.com/a/status/123/video/2'));
});

test('reuse requires an intact local file of the recorded size, duration and tracks',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'video-cache-'));
  try{
    const file=path.join(dir,'video.mp4');await writeFile(file,Buffer.alloc(4096));
    const media={duration:10,width:1280,height:720,audioTracks:1};
    const j={status:'done',url:'https://youtu.be/fs6rjGfPaXg',file,bytes:4096,media,autoTranscribe:false};
    assert.equal(await savedVideo([j],'https://youtube.com/watch?v=fs6rjGfPaXg',async()=>media),j);
    assert.equal(await savedVideo([j],j.url,async()=>({...media,duration:2})),null);
    await writeFile(file,Buffer.alloc(10));assert.equal(await savedVideo([j],j.url,async()=>media),null);
    await rm(file);assert.equal(await savedVideo([j],j.url,async()=>media),null);
    assert.equal(j.autoTranscribe,false);
  }finally{await rm(dir,{recursive:true,force:true})}
});
