import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {discoverProxy} from '../proxy-discovery.mjs';

async function controllers(specs,fn){
  const dir=await mkdtemp('/tmp/video-proxy-'),servers=[],sockets=[];
  try{
    for(const [i,spec]of specs.entries()){
      const socket=dir+'/'+i+'.sock',server=http.createServer((req,res)=>{
        res.writeHead(spec.status||200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(req.url==='/configs'?spec.config:spec.inventory));
      });
      server.listen(socket);await once(server,'listening');servers.push(server);sockets.push(socket);
    }
    await fn(sockets);
  }finally{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));await rm(dir,{recursive:true,force:true})}
}
const remote={proxies:{DIRECT:{type:'Direct'},node:{type:'Vmess'},YouTube:{type:'Selector',all:['node']}}};

test('auto discovery ignores a legacy direct-only kernel and uses the active proxy service',()=>controllers([
  {config:{'mixed-port':7897,tun:{enable:false}},inventory:{proxies:{DIRECT:{type:'Direct'},REJECT:{type:'Reject'}}}},
  {config:{'mixed-port':7900,tun:{enable:true}},inventory:remote}
],async sockets=>assert.equal(await discoverProxy({sockets}),'http://127.0.0.1:7900')));

test('active TUN takes priority, invalid or unauthorized controllers are skipped',()=>controllers([
  {config:{'mixed-port':12345},inventory:remote},
  {config:{'mixed-port':23456,tun:{enable:true}},inventory:remote},
  {config:{'mixed-port':99999},inventory:remote},
  {status:401,config:{'mixed-port':34567},inventory:remote}
],async sockets=>assert.equal(await discoverProxy({sockets}),'http://127.0.0.1:23456')));

test('absent controllers fall back without requiring proxy credentials',async()=>assert.equal(await discoverProxy({sockets:['/tmp/absent-video-proxy-controller.sock']}),''));
