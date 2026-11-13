import { randomUUID, createHash } from 'node:crypto';
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const paragraphs = text => String(text).split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
export const fingerprint = topic => createHash('sha256').update(JSON.stringify([topic.title,topic.audience,topic.purpose,topic.format,topic.documents.map(d=>[d.id,d.title,d.text])])).digest('hex');
export function documentOf({title='未命名文案',text='',source=''}) {
  text=String(text).trim();
  if(!text || text.length>40000) throw new Error('每篇文案需要 1–40000 个字符');
  return {id:uid(),title:String(title).slice(0,150),text,source:String(source).slice(0,1000),createdAt:now()};
}
export function topicOf({title,audience='',purpose='',format='短视频口播',documents=[]}) {
  if(!String(title||'').trim()) throw new Error('请填写选题名称');
  return {id:uid(),title:String(title).trim().slice(0,150),audience:String(audience).slice(0,1000),purpose:String(purpose).slice(0,2000),format:String(format).slice(0,100),documents:documents.map(documentOf),selections:[],draft:'',notes:'',analysis:null,createdAt:now(),updatedAt:now()};
}
export function seedState() {
  const topic=topicOf({title:'第一条视频，怎么开口？',audience:'想开始表达、却迟迟没有发出第一条视频的人',purpose:'让观众愿意先拍一条，分享自己的真实经历',documents:[
    {title:'从一个小动作开始',source:'示例 · 行动视角',text:'你手机里，是不是也躺着一条一直没发的视频？\n\n我第一条视频录了二十七遍。最后发出去的，却是第一遍。因为后面每一遍，我都在想别人会怎么看我，反而忘了自己想说什么。\n\n后来我给自己定了一个小规则：今天只讲一件亲身经历的小事。不找金句，不等状态，也不假装什么都懂。\n\n如果你也卡在第一条，今天就试着对镜头说一句：最近有件事，我想和你聊聊。'},
    {title:'把镜头当成一个人',source:'示例 · 故事视角',text:'我曾经花了一个月，准备一条三十秒的视频。\n\n买灯、找背景、改开场白，忙得像已经做了很多内容。可相册里的草稿越积越多，发布按钮一次也没有按下。\n\n有天朋友问我，你到底想把这件事讲给谁听？我突然发现，我一直在对着一群想象中的评委说话。于是我把镜头当成那个朋友，重新讲了一遍。\n\n那一遍有停顿，也有口误。但那是我第一次觉得，镜头里的人像我自己。先想一个你愿意分享的人，再试着开始。'},
    {title:'允许第一条普通一点',source:'示例 · 共鸣视角',text:'第一条视频，需要做到什么程度才能发？\n\n有人说要有反转，有人说要有金句。我照着改了又改，最后连自己都认不出那段话是谁说的。\n\n其实第一条的意义，是让你有机会拍第二条。一个真实的细节，一句你平时会说的话，就足够成为起点。\n\n先发出来，再慢慢长出自己的表达。你最想讲、却还没开口的那件事是什么？'}
  ]});
  return {schemaVersion:1,revision:0,topics:[topic],archives:[]};
}
export function selectFragment(topic,{documentId,paragraphIndex=null,start=null,end=null,kind='paragraph',note=''}) {
  const doc=topic.documents.find(d=>d.id===documentId); if(!doc)throw new Error('找不到原始文案');
  let text, key;
  if(kind==='document'){text=doc.text;key=doc.id+':whole';}
  else {
    const p=paragraphs(doc.text)[paragraphIndex]; if(p===undefined)throw new Error('找不到原始段落');
    if(kind==='sentence') {
      if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>p.length||end<=start)throw new Error('选中文字的位置无效');
      text=p.slice(start,end);key=`${doc.id}:${paragraphIndex}:${start}:${end}`;
    } else {text=p;key=`${doc.id}:${paragraphIndex}`;}
  }
  const existing=topic.selections.find(s=>s.key===key&&s.text===text);
  if(existing){topic.selections=topic.selections.filter(s=>s.id!==existing.id);return null;}
  const selection={id:uid(),key,documentId,documentTitle:doc.title,paragraphIndex,start,end,kind,text,sourceParagraph:kind==='document'?null:paragraphs(doc.text)[paragraphIndex],note:String(note).slice(0,2000),createdAt:now()};
  topic.selections.push(selection);return selection;
}
export function archiveOf(topic,previous=[]) {
  const existing=previous.find(a=>a.topicId===topic.id),savedAt=now();
  const round=(existing?.round||0)+1;
  const history=structuredClone(existing?.history||[]);
  history.push({version:round,savedAt,topic:structuredClone(topic)});
  return {id:topic.id,topicId:topic.id,round,savedAt,topic:structuredClone(topic),history,signature:archiveSignature(topic),syncKey:uid(),sync:{status:'pending',message:'等待同步到飞书'}};
}
export const archiveSignature=t=>JSON.stringify([t.title,t.audience,t.purpose,t.format,t.documents,t.selections,t.draft,t.finalDraft,t.notes,t.analysis,t.operations,t.previousSelections,t.removedDocuments,t.documentHistory]);
export function logOperation(topic,type,label){
  topic.operations??=[];
  const last=topic.operations.at(-1),at=now();
  if(type==='draft.edit'&&last?.type===type&&Date.now()-Date.parse(last.at)<60000){last.at=at;return;}
  topic.operations.push({id:uid(),at,type,label});
}
export function migrateArchives(state){
  if(state.schemaVersion>=2)return false;
  const grouped=new Map();
  for(const a of state.archives){if(!grouped.has(a.topicId))grouped.set(a.topicId,[]);grouped.get(a.topicId).push(a);}
  const result=[];
  for(const [topicId,items]of grouped){
    items.sort((a,b)=>a.savedAt.localeCompare(b.savedAt));
    const latest=structuredClone(items.at(-1)),t=latest.topic;
    const final=items.findLast(a=>a.topic.draft?.trim());
    t.finalDraft=final?{text:final.topic.draft,confirmedAt:final.savedAt}:null;
    t.operations=items.map(a=>({id:a.id,at:a.savedAt,type:'archive.save',label:`保存第 ${a.round} 版选稿（从旧档案合并）`}));
    latest.id=topicId;latest.history=items.map(a=>({version:a.round,savedAt:a.savedAt,topic:structuredClone(a.topic)}));
    latest.signature=archiveSignature(t);latest.syncKey=uid();latest.sync={status:'pending',message:'档案已合并，等待同步飞书'};
    const live=state.topics.find(x=>x.id===topicId);if(live){live.finalDraft=structuredClone(t.finalDraft);live.operations=structuredClone(t.operations);}
    result.push(latest);
  }
  state.archives=result.sort((a,b)=>b.savedAt.localeCompare(a.savedAt));state.trash??=[];state.schemaVersion=2;return true;
}
