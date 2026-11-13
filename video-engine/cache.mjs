import { stat } from 'node:fs/promises';
import { platformFor,platformVideoId } from './platforms.mjs';

export function sourceKey(url){
  const p=platformFor(url),id=platformVideoId(url);if(!p||!id)return url;
  const u=new URL(url);
  const part=p.id==='bilibili'?(u.searchParams.get('p')||'1'):p.id==='twitter'?(u.pathname.match(/\/video\/(\d+)/)?.[1]||'1'):'';
  return `${p.id}:${id}:${part}`;
}

export async function savedVideo(jobs,url,probe){
  for(const j of [...jobs].reverse()){
    if(j.status!=='done'||!j.file||sourceKey(j.url)!==sourceKey(url))continue;
    try{
      if((await stat(j.file)).size!==j.bytes)continue;
      const media=await probe(j.file);
      if(Math.abs(media.duration-j.media.duration)>1 || media.width!==j.media.width || media.height!==j.media.height || media.audioTracks!==j.media.audioTracks)continue;
      return j;
    }catch{}
  }
  return null;
}
