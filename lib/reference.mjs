import {paragraphs} from './model.mjs';
const label={recommend:'可采纳',improve:'需优化',skip:'不建议用',neutral:'一般段落',duplicate:'内容重复'};
export function referenceFields(topic,doc,recordId,status='正常'){
  const analysis=topic.analysis?.documents.find(x=>x.documentId===doc.id),selected=topic.selections.filter(s=>s.documentId===doc.id),parts=paragraphs(doc.text);
  const location=s=>s.kind==='document'?'整篇':`第 ${s.paragraphIndex+1} 段${s.kind==='sentence'?'中的句子':''}`;
  const valid=s=>!s.sourceDetached&&(s.kind==='document'?s.text===doc.text:s.kind==='sentence'?parts[s.paragraphIndex]?.slice(s.start,s.end)===s.text:parts[s.paragraphIndex]===s.text);
  const selectionText=selected.map(s=>`【${location(s)}${valid(s)?'':' · 原稿修改前的选择'}】\n${s.text}${s.note?'\n我的理由：'+s.note:''}`).join('\n\n');
  const reasons=selected.map(s=>{
    const advice=s.kind==='document'?analysis?.summary:valid(s)?analysis?.paragraphs.find(p=>p.index===s.paragraphIndex)?.reason:null;
    return `【${location(s)}】\n我的理由：${s.note||'未填写'}${advice?'\n分析建议：'+advice:''}`;
  }).join('\n\n');
  const annotated=parts.map((text,index)=>{
    const picks=selected.filter(s=>valid(s)&&(s.kind==='document'||s.paragraphIndex===index));
    const whole=picks.some(s=>s.kind==='document'||s.kind==='paragraph');
    const a=analysis?.paragraphs.find(p=>p.index===index);
    return `第 ${index+1} 段 · ${whole?'✓ 已选整段':picks.length?'✓ 已选其中句子':'未选择'}\n${text}\n${a?`${label[a.label]}：${a.reason}`:topic.analysis?.reviewVersion?'未标记重点；可自行选择':'尚未分析'}${!whole&&picks.length?'\n选中的句子：'+picks.map(s=>s.text).join('；'):''}`;
  }).join('\n\n');
  return {'文案标题':doc.title,'记录编号':`${topic.id}:${doc.id}`,'所属选题':[{id:recordId}],'原始文案':doc.text,'来源':doc.source,'整体评分':analysis?.score??null,'整体评价':analysis?.summary||'尚未分析','维度评分':analysis?.dimensions?.map(x=>`${x.name}：${x.score}分\n${x.reason}`).join('\n\n')||(analysis?'评分依据见整体评价与原文批注':'尚未分析'),'段落分析':annotated,'我的选择':selectionText||'尚未选择这篇文案的内容','选择理由':reasons||'尚未选择','档案状态':status,'继续挑选':`http://127.0.0.1:43828/#/compare/${topic.id}`};
}
export const sourceFields=archiveTableId=>[{name:'文案标题',type:'text'},{name:'记录编号',type:'text'},{name:'所属选题',type:'link',link_table:archiveTableId,bidirectional:true,bidirectional_link_field_name:'参考原文'},...['原始文案','来源'].map(name=>({name,type:'text'})),{name:'整体评分',type:'number'},...['整体评价','维度评分','段落分析','我的选择','选择理由','档案状态'].map(name=>({name,type:'text'})),{name:'继续挑选',type:'text',style:{type:'url'}}];
