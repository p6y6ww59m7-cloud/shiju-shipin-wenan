import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';

export async function existingEngine(dataDir){
  try{
    const session=JSON.parse(await readFile(path.join(dataDir,'engine-session.json'),'utf8'));
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(session.url)||!session.token)return null;
    const response=await fetch(session.url+'/api/state',{headers:{'x-session-token':session.token},signal:AbortSignal.timeout(1200)});
    return response.ok?session:null;
  }catch{return null}
}

// Both desktop entries and the workbench share one owner of the history and queues.
export async function claimEngine(dataDir){
  const lock=path.join(dataDir,'engine.lock'),file=path.join(dataDir,'engine-session.json');
  for(let attempt=0;attempt<60;attempt++){
    const existing=await existingEngine(dataDir);if(existing)return {existing};
    try{
      await mkdir(lock,{mode:0o700});
      await writeFile(path.join(lock,'pid'),String(process.pid),{mode:0o600});
      return {
        async publish(url,token){await writeFile(file+'.tmp',JSON.stringify({url,token,pid:process.pid}),{mode:0o600});await rename(file+'.tmp',file)},
        async release(){
          try{const owner=JSON.parse(await readFile(file,'utf8'));if(owner.pid===process.pid)await rm(file,{force:true})}catch{}
          try{if(Number(await readFile(path.join(lock,'pid'),'utf8'))===process.pid)await rm(lock,{recursive:true,force:true})}catch{}
        }
      };
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      try{const pid=Number(await readFile(path.join(lock,'pid'),'utf8'));try{process.kill(pid,0)}catch(err){if(err.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue}}}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  throw new Error('下载服务正在启动，请稍后重试。');
}
