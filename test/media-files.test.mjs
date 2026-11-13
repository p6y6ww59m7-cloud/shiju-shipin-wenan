import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {streamMedia} from '../lib/media-files.mjs';

test('本地视频支持完整读取、时间拖动的范围请求、HEAD和无效范围拒绝',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'shiju-media-range-')),file=path.join(dir,'video.mp4');await writeFile(file,'0123456789');
  const server=http.createServer((req,res)=>streamMedia(req,res,file));server.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal(await(await fetch(url)).text(),'0123456789');
    let r=await fetch(url,{headers:{Range:'bytes=3-6'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 3-6/10');assert.equal(await r.text(),'3456');
    r=await fetch(url,{headers:{Range:'bytes=-3'}});assert.equal(await r.text(),'789');
    r=await fetch(url,{method:'HEAD'});assert.equal(r.headers.get('content-length'),'10');assert.equal(await r.text(),'');
    r=await fetch(url,{headers:{Range:'bytes=99-100'}});assert.equal(r.status,416);
    r=await fetch(url,{headers:{Range:'bytes=0-1,4-5'}});assert.equal(r.status,416);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}
});
