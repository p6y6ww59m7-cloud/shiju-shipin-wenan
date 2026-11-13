import { platformFor } from '../platforms.mjs';

export function hasVideoLink(text) {
  return (String(text).match(/https?:\/\/[^\s<>"“”‘’]+/g)||[]).some(value=>platformFor(value.replace(/[，。；！？、）)\]】}]+$/u,'')));
}

// Capture each paste once, retaining newer input while a previous request is in flight.
export function createAutoIntake({ getText, submit, accepted=()=>{}, failed=()=>{}, busy=()=>{}, delay=650 }) {
  let timer, running=false, pending=false, stopped=false;
  async function flush() {
    clearTimeout(timer);
    if(stopped)return;
    if(running){pending=true;return}
    const text=getText().trim();
    if(!hasVideoLink(text))return;
    running=true;busy(true);
    try{const result=await submit(text);accepted(text,result)}catch(e){failed(e)}
    finally{
      running=false;busy(false);
      if(pending){pending=false;schedule()}
    }
  }
  function schedule(){if(stopped)return;clearTimeout(timer);timer=setTimeout(flush,delay)}
  return { schedule, flush, stop(){stopped=true;clearTimeout(timer)} };
}
