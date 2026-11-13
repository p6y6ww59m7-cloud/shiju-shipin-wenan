import http from 'node:http';

const defaultSockets=()=>[
  `/var/run/clash-verge-service/users/${process.getuid?.()??501}/verge-mihomo.sock`,
  '/tmp/clash-neo/clash-neo-mihomo.sock'
];

function localJSON(socketPath,route){
  return new Promise((resolve,reject)=>{
    const req=http.get({socketPath,path:route},res=>{
      if(res.statusCode!==200){res.resume();reject(new Error('controller unavailable'));return}
      let body='';res.setEncoding('utf8');
      res.on('data',chunk=>{body+=chunk;if(body.length>4000000)req.destroy(new Error('controller response too large'))});
      res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){reject(e)}});
    });
    req.on('error',reject);req.setTimeout(900,()=>req.destroy(new Error('controller timeout')));
  });
}

export async function discoverProxy({sockets=defaultSockets()}={}){
  const candidates=await Promise.all(sockets.map(async socket=>{
    try{
      const [config,inventory]=await Promise.all([localJSON(socket,'/configs'),localJSON(socket,'/proxies')]);
      const proxies=Object.values(inventory.proxies||{});
      // A listening legacy kernel containing only DIRECT/REJECT is not an upstream proxy.
      if(!proxies.some(p=>!Array.isArray(p.all)&&!/^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(p.type||'')))return null;
      const port=Number(config['mixed-port']||config.port||config['socks-port']);
      if(!Number.isInteger(port)||port<1||port>65535)return null;
      const protocol=config['mixed-port']||config.port?'http':'socks5h';
      return {url:`${protocol}://127.0.0.1:${port}`,score:(config.tun?.enable?100:0)+(inventory.proxies.YouTube?10:0)};
    }catch{return null}
  }));
  return candidates.filter(Boolean).sort((a,b)=>b.score-a.score)[0]?.url||'';
}
