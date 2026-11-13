// Keep one persisted order for both the favorites list and the drafting shelf.
export function moveItem(items,from,to){
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=items.length||to>=items.length)throw new Error('移动位置无效');
  const [item]=items.splice(from,1);items.splice(to,0,item);
}
export function moveSelection(topic,{selectionId,toIndex,direction,beforeId,afterId}){
  const from=topic.selections.findIndex(s=>s.id===selectionId);
  if(from<0)throw new Error('精选不存在');
  let to;
  if(beforeId||afterId){
    const target=topic.selections.findIndex(s=>s.id===(beforeId||afterId));
    if(target<0)throw new Error('目标精选不存在');
    if(target===from)return;
    to=target-(from<target?1:0)+(afterId?1:0);
  }else to=toIndex??(from+Number(direction));
  moveItem(topic.selections,from,to);
}
export function cleanDraft(text){
  return String(text).replace(/\r\n?/g,'\n').replace(/^[\t \u3000]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
}
export function appendDraft(draft,text){
  return [String(draft).trimEnd(),String(text).trim()].filter(x=>x.trim()).join('\n\n');
}
export function insertDraft(draft,text,at){
  if(!Number.isInteger(at)||at<0||at>draft.length)throw new Error('插入位置无效');
  const left=draft.slice(0,at).trimEnd(),right=draft.slice(at).trimStart();
  return [left,String(text).trim(),right].filter(x=>x.trim()).join('\n\n');
}
export function draftParagraphs(text){return cleanDraft(text).split(/\n\s*\n/).filter(Boolean);}
export function moveDraftParagraph(draft,from,to){
  const parts=draftParagraphs(draft);moveItem(parts,from,to);return parts.join('\n\n');
}
