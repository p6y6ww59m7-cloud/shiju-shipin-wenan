import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';

// Only paths obtained from the saved asset record reach this function.
export async function streamMedia(req,res,file){
  let info;try{info=await stat(file)}catch{res.writeHead(404,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'视频文件已移动或删除，请重新下载。'}));return}
  if(!info.isFile()){res.writeHead(404);res.end();return}
  const headers={'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  let start=0,end=info.size-1,status=200;
  if(req.headers.range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return}
    if(!m[1])start=Math.max(0,info.size-Number(m[2]));
    else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]))}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(status,headers);
  if(req.method==='HEAD'){res.end();return}
  const stream=createReadStream(file,{start,end});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
}
