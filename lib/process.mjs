import { spawn } from 'node:child_process';
export function run(command,args,{cwd,input,timeout=60000,onOutput,onStderr,signal}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return resolve({code:null,stdout:'',stderr:'',timedOut:false,aborted:true});
    const grouped=process.platform!=='win32';
    const child=spawn(command,args,{cwd,detached:grouped,env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,aborted=false,done=false,stopping=false,killTimer,settleTimer;
    const kill=sig=>{try{if(grouped&&child.pid)process.kill(-child.pid,sig);else child.kill(sig);}catch{}};
    const finish=(code,error)=>{if(done)return;done=true;clearTimeout(timer);if(!stopping)clearTimeout(killTimer);clearTimeout(settleTimer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve({code,stdout,stderr,timedOut,aborted});};
    const stop=()=>{if(done||stopping)return;stopping=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);killTimer.unref();settleTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();finish(null);},2000);};
    const abort=()=>{aborted=true;stop();};
    const timer=timeout>0?setTimeout(()=>{timedOut=true;stop();},timeout):null;
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8e6){stderr+='\n输出超过限制';stop();}onOutput?.(String(chunk));});
    child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>2e6)stderr=stderr.slice(-2e6);onStderr?.(String(chunk));});
    child.on('error',e=>finish(null,e));
    child.on('close',code=>finish(code));
    child.stdin.on('error',()=>{});child.stdin.end(input||'');
  });
}
export function parseJSON(text){try{return JSON.parse(text.trim())}catch{for(const line of text.split('\n').reverse()){try{return JSON.parse(line)}catch{}}return null;}}
