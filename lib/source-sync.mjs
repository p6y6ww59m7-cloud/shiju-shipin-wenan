import {paragraphs,now} from './model.mjs';

const positions=(text,part)=>{const out=[];if(!part)return out;for(let i=text.indexOf(part);i>=0;i=text.indexOf(part,i+1))out.push(i);return out;};
function paragraphMap(before,after){
  const map=new Map(),anchors=[];
  if(before.length===after.length&&before.every((p,i)=>p===after[i]))return new Map(before.map((_,i)=>[i,i]));
  for(let i=0;i<before.length;i++){const hits=after.flatMap((p,j)=>p===before[i]?[j]:[]);if(hits.length===1&&before.filter(p=>p===before[i]).length===1){map.set(i,hits[0]);anchors.push([i,hits[0]]);}}
  // Only infer a changed paragraph inside a one-to-one gap with stable neighbours.
  const monotonic=anchors.every((a,i)=>!i||a[1]>anchors[i-1][1]);
  if(monotonic){const edges=[[-1,-1],...anchors,[before.length,after.length]];for(let k=1;k<edges.length;k++){const [a,b]=edges[k-1],[c,d]=edges[k];if(c-a===2&&d-b===2&&(anchors.length||before.length===1&&after.length===1))map.set(a+1,b+1);}}
  return map;
}
function sentenceRange(selection,oldText,newText){
  if(oldText===newText&&oldText.slice(selection.start,selection.end)===selection.text)return [selection.start,selection.end];
  const hits=positions(newText,selection.text);if(hits.length===1)return [hits[0],hits[0]+selection.text.length];
  if(oldText.slice(selection.start,selection.end)!==selection.text)return null;
  let prefix=0,suffix=0;while(prefix<Math.min(oldText.length,newText.length)&&oldText[prefix]===newText[prefix])prefix++;
  while(suffix<Math.min(oldText.length,newText.length)-prefix&&oldText.at(-1-suffix)===newText.at(-1-suffix))suffix++;
  if(selection.start<=prefix&&selection.end>=oldText.length-suffix)return [selection.start,selection.end+newText.length-oldText.length];
  return null;
}
function archiveSelection(topic,selection,reason){
  topic.previousSelections??=[];topic.previousSelections.push({...structuredClone(selection),archivedAt:now(),archiveReason:reason});
}
function syncDraft(topic,replacements){
  const original=topic.draft||'',changes=[],ambiguous=new Set();
  const byOld=new Map();for(const r of replacements){if(r.oldText===r.newText)continue;if(byOld.has(r.oldText)&&byOld.get(r.oldText)!==r.newText)ambiguous.add(r.oldText);byOld.set(r.oldText,r.newText);}
  for(const [oldText,newText]of byOld){if(ambiguous.has(oldText))continue;for(const start of positions(original,oldText)){
    const end=start+oldText.length;
    // Only untouched complete blocks are linked; free rewrites and substrings stay user-owned.
    if((start===0||original.slice(0,start).endsWith('\n\n'))&&(end===original.length||original.slice(end).startsWith('\n\n')))changes.push({start,end,newText});
  }}
  changes.sort((a,b)=>a.start-b.start||b.end-a.end);const accepted=[];for(const c of changes)if(!accepted.length||c.start>=accepted.at(-1).end)accepted.push(c);
  for(const c of accepted.reverse())topic.draft=topic.draft.slice(0,c.start)+c.newText+topic.draft.slice(c.end);
  return accepted.length;
}
export function updateDocument(topic,documentId,next){
  const doc=topic.documents.find(d=>d.id===documentId);if(!doc)throw new Error('文案不存在');
  const before=structuredClone(doc),oldParts=paragraphs(doc.text),newParts=paragraphs(next.text),mapping=paragraphMap(oldParts,newParts),replacements=[],kept=[];
  let updated=0,archived=0;
  for(const s of topic.selections){
    if(s.documentId!==documentId||s.sourceDetached){kept.push(s);continue;}
    let index,text,start=s.start,end=s.end;
    if(s.kind==='document'){text=next.text;}
    else {
      const exact=s.kind==='paragraph'?newParts.flatMap((p,i)=>p===s.text?[i]:[]):[];
      index=exact.length===1?exact[0]:mapping.get(s.paragraphIndex);
      if(index!==undefined){if(s.kind==='sentence'){const range=sentenceRange(s,s.sourceParagraph||oldParts[s.paragraphIndex]||'',newParts[index]);if(range){[start,end]=range;text=newParts[index].slice(start,end);}}else if(oldParts[s.paragraphIndex]===s.text||exact.length===1)text=newParts[index];}
    }
    if(!text){archiveSelection(topic,s,'原段落已删除或大幅改写，无法准确关联');archived++;continue;}
    const oldText=s.text;Object.assign(s,{documentTitle:next.title,text,paragraphIndex:s.kind==='document'?null:index,start,end,sourceParagraph:s.kind==='document'?null:newParts[index]});
    s.key=s.kind==='document'?documentId+':whole':s.kind==='sentence'?`${documentId}:${index}:${start}:${end}`:`${documentId}:${index}`;
    if(oldText!==text){updated++;replacements.push({oldText,newText:text});s.sourceUpdatedAt=now();}
    kept.push(s);
  }
  topic.selections=kept;
  const draftUpdates=syncDraft(topic,replacements);
  topic.documentHistory??=[];topic.documentHistory.push({...before,replacedAt:now()});
  Object.assign(doc,{title:next.title,text:next.text,source:next.source,updatedAt:now()});topic.analysis=null;
  topic.sourceSync={at:now(),updated,archived,draftUpdates,draftReview:!!topic.draft&&(updated>draftUpdates||archived>0)};
  return topic.sourceSync;
}
export function reconcileLegacySelections(topic){
  if(topic.sourceSyncVersion>=1)return false;
  let archived=0;const kept=[];
  for(const s of topic.selections){const doc=topic.documents.find(d=>d.id===s.documentId);let index,range;
    if(doc){const ps=paragraphs(doc.text);
      if(s.kind==='document'&&s.text===doc.text){s.documentTitle=doc.title;kept.push(s);continue;}
      if(s.kind==='paragraph'){if(ps[s.paragraphIndex]===s.text)index=s.paragraphIndex;else{const matches=ps.flatMap((p,i)=>p===s.text?[i]:[]);if(matches.length===1)index=matches[0];}}
      if(s.kind==='sentence'){const matches=ps.flatMap((p,i)=>positions(p,s.text).map(start=>({i,start})));if(matches.length===1){index=matches[0].i;range=[matches[0].start,matches[0].start+s.text.length];}}
      if(index!==undefined){Object.assign(s,{documentTitle:doc.title,paragraphIndex:index,sourceParagraph:ps[index]});if(range)[s.start,s.end]=range;s.key=s.kind==='sentence'?`${doc.id}:${index}:${s.start}:${s.end}`:`${doc.id}:${index}`;kept.push(s);continue;}
    }
    archiveSelection(topic,s,'原文已被替换，此处是修改前收藏的内容');archived++;
  }
  topic.selections=kept;topic.sourceSyncVersion=1;
  if(archived)topic.sourceSync={at:now(),updated:0,archived,draftUpdates:0,draftReview:!!topic.draft};return true;
}
export function removeDocument(topic,id){
 const index=topic.documents.findIndex(d=>d.id===id);if(index<0)throw new Error('文案不存在');
 const selections=topic.selections.flatMap((s,i)=>s.documentId===id?[{selection:structuredClone(s),index:i}]:[]);
 topic.removedDocuments??=[];topic.removedDocuments.push({document:topic.documents[index],index,selections,deletedAt:now()});
 topic.documents.splice(index,1);topic.selections=topic.selections.filter(s=>s.documentId!==id);topic.analysis=null;
 topic.sourceSync={at:now(),updated:0,archived:0,draftUpdates:0,draftReview:!!topic.draft&&selections.length>0};
}
export function restoreDocument(topic,id){
 const record=topic.removedDocuments?.find(x=>x.document.id===id);if(!record)throw new Error('已删文案不存在');if(topic.documents.length>=8)throw new Error('最多8篇，请先删除其他文案');
 topic.documents.splice(Math.min(record.index,topic.documents.length),0,record.document);
 for(const {selection,index}of record.selections)if(!topic.selections.some(s=>s.id===selection.id))topic.selections.splice(Math.min(index,topic.selections.length),0,selection);
 topic.removedDocuments=topic.removedDocuments.filter(x=>x!==record);topic.analysis=null;
}
