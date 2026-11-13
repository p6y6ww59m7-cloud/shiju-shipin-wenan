import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runReview,REVIEW_EFFORT} from '../lib/quick-review.mjs';
const state=JSON.parse(await readFile(new URL('../data/state.json',import.meta.url),'utf8'));
const topic=process.argv[4]?state.topics.find(t=>t.id===process.argv[4]):state.topics[0];
if(!topic)throw new Error('验收选题不存在');
const effort=process.argv[2]||REVIEW_EFFORT,label=process.argv[3]||Date.now().toString(),dir=path.resolve('data/benchmarks',label+'-'+effort);
await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'input.json'),JSON.stringify({id:topic.id,title:topic.title,audience:topic.audience,purpose:topic.purpose,format:topic.format,documents:topic.documents}));
console.log(JSON.stringify({event:'start',effort,dir,documents:topic.documents.length,characters:topic.documents.reduce((s,d)=>s+d.text.length,0)}));
try{const {analysis,metrics}=await runReview({topic,dir,effort,command:process.env.CODEX_CLI||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'});await writeFile(path.join(dir,'validated.json'),JSON.stringify(analysis,null,2));console.log(JSON.stringify({event:'complete',metrics,scores:analysis.documents.map(d=>d.score)}));}catch(e){console.log(JSON.stringify({event:'failed',message:e.message,timing:JSON.parse(await readFile(path.join(dir,'timing.json'),'utf8'))}));process.exitCode=1;}
