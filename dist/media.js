import {createAutoIntake} from './video-intake.mjs';

const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>(Number(n||0)/1048576).toFixed(1)+' MB';
const duration=seconds=>{const n=Math.max(0,Math.round(seconds||0));return `${Math.floor(n/60)}分${String(n%60).padStart(2,'0')}秒`};
const stamp=ms=>duration(ms/1000);
const busy=s=>['queued','opening','waiting','downloading','cancelling'].includes(s);
const speechBusy=s=>['queued','extracting','recognizing','writing','cancelling'].includes(s);
const button=(action,label,id='',extra='')=>`<button type="button" class="button small" data-media-action="${action}" data-id="${escape(id)}" ${extra}>${label}</button>`;

export function createMediaUI(ctx){
  let library={assets:[],engine:{message:'正在连接本机服务…'}},text='',targetTopic,contextTopic,filter='all',query='',currentView='',timer,refreshing=false,submitting=false;
  const optimistic=new Map();let renderedList,renderedCards;
  const intake=createAutoIntake({getText:()=>text,submit:async value=>{
    const result=await ctx.api('/api/media/intake',{text:value,topicId:targetTopic||null});
    await refresh();await ctx.refresh();return result;
  },accepted:(value,result)=>{if(text===value){text='';const field=document.querySelector('#media-links');if(field)field.value=''}ctx.toast(`已添加 ${result.added} 条${result.reused?'，复用 '+result.reused+' 条本地视频':''}`)},failed:e=>ctx.toast(e.message,true),busy:value=>{submitting=value;const b=document.querySelector('#media-submit');if(b)b.disabled=value}});

  function view(){
    const state=ctx.state(),id=ctx.mediaTopicId();
    if(contextTopic!==id){contextTopic=id;targetTopic=id||''}
    return `<div class="page-heading"><div><div class="eyebrow">FROM VIDEO TO YOUR WORDS</div><h1>留住视频，<em>挑出好文案。</em></h1><p>支持抖音、YouTube、B站、快手、X / Twitter。粘贴即下载，需要文字时逐条勾选。</p></div></div>
      <section class="media-intake"><form id="media-intake-form"><label for="media-links" class="section-label">粘贴视频分享链接</label><textarea id="media-links" aria-label="视频分享链接" placeholder="粘贴链接或完整分享文字，可一次添加最多 30 条。">${escape(text)}</textarea><div class="media-intake-bottom"><label>新增素材归属 <select id="media-target" aria-label="新增素材归属"><option value="" ${!targetTopic?'selected':''}>素材库 · 暂不归类</option>${state.topics.map(t=>`<option value="${escape(t.id)}" ${t.id===targetTopic?'selected':''}>${escape(t.title)}</option>`).join('')}</select></label><span>最高原画 · 勾选才转文字 · 完成后自动加入所选选题</span><button id="media-submit" type="submit" class="button primary" ${submitting?'disabled':''}>${submitting?'正在添加…':'添加链接'}</button></div></form></section>
      <div class="media-toolbar"><div class="segmented">${[['all','全部素材'],['topic','当前选题'],['unassigned','未归类']].map(([id,label])=>`<button type="button" class="${filter===id?'active':''}" data-media-action="filter" data-id="${id}">${label}</button>`).join('')}</div><input id="media-search" type="search" aria-label="搜索视频素材" placeholder="搜索标题、作者、来源" value="${escape(query)}"><div>${button('pause',library.paused?'继续队列':'暂停队列')}${button('folder','打开保存目录')}${button('settings','网络设置')}</div></div>
      <p class="media-service" id="media-service"></p><div id="media-list" class="media-list" aria-live="polite">${cards()}</div>`;
  }

  function card(a){
    const p=a.progress||{},speech=p.transcript||a.transcriptStatus,checked=optimistic.has(a.id)?optimistic.get(a.id):a.autoTranscribe;
    const status=({queued:'排队中',opening:'正在解析',waiting:'等待验证',downloading:'下载中',cancelling:'正在取消',done:'已保存',error:'下载失败',cancelled:'已跳过',interrupted:'已中断'})[a.status]||'等待处理';
    const topics=ctx.state().topics,tid=targetTopic||ctx.topicId(),doc=topics.find(t=>t.id===tid)?.documents.find(d=>d.media?.assetId===a.id&&d.media?.transcriptId===a.transcriptId);
    const info=a.media?`${a.media.width} × ${a.media.height} · ${duration(a.media.duration)}${a.media.audioTracks?' · 含声音':''}`:'';
    const progress=busy(a.status)&&p.bytes?`${size(p.bytes)}${p.total?' / '+size(p.total):''}${p.speed?' · '+Math.round(p.speed/1024)+' KB/秒':''}${p.eta!=null?' · 预计剩余 '+duration(p.eta):''}`:a.status==='done'?`${info}${a.bytes?' · '+size(a.bytes):''}`:a.message||status;
    const waiting=a.topicIds.some(id=>topics.some(t=>t.id===id))&&a.transcriptId&&!doc;
    const labels=a.topicIds.map(id=>topics.find(t=>t.id===id)?.title).filter(Boolean);
    return `<article class="media-card" data-asset="${escape(a.id)}"><div class="media-card-top"><div><span class="media-platform">${escape(a.platformLabel||a.platform||'视频')}</span><h2 title="${escape(a.title||'')}">${escape(a.title||'正在识别视频')}</h2><p>${escape(a.author||'')}${labels.length?' · '+escape(labels.join(' / ')):' · 未归类'}</p></div><span class="media-status ${escape(a.status)}">${status}</span></div><p class="media-progress">${escape(progress)}</p>${a.status==='downloading'&&p.total?`<progress value="${p.bytes||0}" max="${p.total}"></progress>`:''}
      <div class="media-card-actions"><label class="media-choice"><input type="checkbox" data-media-choice="${escape(a.id)}" ${checked?'checked':''} ${optimistic.has(a.id)?'disabled':''}>转文字</label><span class="media-speech-state">${escape(speechBusy(speech?.status)?speech.message:speech?.status==='error'?speech.message:a.transcriptId?'已有口播文稿 · '+a.characters+' 字':'勾选后使用本地高精度模型')}</span><div class="media-actions-right">${a.file?button('viewer','查看视频'+(a.transcriptId?'与文稿':''),a.id)+button('reveal','定位文件',a.id):''}${p.access?button('access',p.access.kind==='verification'?'去完成验证':'去登录',a.id):''}${busy(a.status)?button('cancel','跳过',a.id):['error','cancelled','interrupted'].includes(a.status)?button('retry','重试下载',a.id):''}${speech?.status==='error'||speech?.status==='cancelled'||speech?.status==='interrupted'?button('transcribe','重试转写',a.id):''}${speechBusy(speech?.status)?button('cancel-transcription','取消转写',a.id):''}${doc?`<a class="button small soft" href="#/compare/${escape(tid)}">查看文案 ↗</a>`:a.transcriptId&&tid?button('attach','加入当前选题',a.id,`data-topic="${escape(tid)}"`):''}${a.status==='done'?button('redownload','重新下载',a.id):''}${button('assign','关联选题',a.id)}</div></div>
      ${waiting&&topics.find(t=>t.id===tid)?.documents.length>=8?'<p class="media-capacity-note">转写稿已保留在素材库。每组最多对比 8 篇；可移出一篇再加入，或关联其他选题。</p>':waiting&&a.characters>40000?'<p class="media-capacity-note">全文已保留；超过单篇 4 万字，请分段加入文案。</p>':''}</article>`;
  }

  function cards(){
    const rows=library.assets.filter(a=>(filter!=='topic'||a.topicIds.includes(targetTopic||ctx.topicId()))&&(filter!=='unassigned'||!a.topicIds.some(id=>ctx.state().topics.some(t=>t.id===id)))&&(!query||[a.title,a.author,a.url].join(' ').toLowerCase().includes(query.toLowerCase())));
    return rows.map(card).join('')||'<div class="empty-state"><span class="empty-icon">↙</span><h3>把想保留的视频放进来</h3><p>粘贴链接后自动下载；勾选「转文字」，口播稿会进入对应选题。</p></div>';
  }

  function paint(){
    if(currentView!=='media')return;
    const list=document.querySelector('#media-list'),status=document.querySelector('#media-service');
    if(list){const html=cards();if(list!==renderedList||html!==renderedCards){list.innerHTML=html;renderedList=list;renderedCards=html}}
    for(const el of document.querySelectorAll('[data-media-action="filter"]'))el.classList.toggle('active',el.dataset.id===filter);
    const pause=document.querySelector('[data-media-action="pause"]');if(pause)pause.textContent=library.paused?'继续队列':'暂停队列';
    if(status)status.textContent=library.error||`${library.engine?.message||'正在连接本机服务…'} · ${library.assets.length} 条素材${library.paused?' · 队列已暂停':''}`;
  }
  async function refresh(){
    if(refreshing)return;refreshing=true;
    try{const previous=library.assets.reduce((n,a)=>n+a.transcripts.length+a.imports.length,0);library=await ctx.api('/api/media/state');paint();const next=library.assets.reduce((n,a)=>n+a.transcripts.length+a.imports.length,0);if(next!==previous)await ctx.refresh()}
    catch(e){if(currentView==='media'){const status=document.querySelector('#media-service');if(status)status.textContent=e.message}}
    finally{refreshing=false}
  }
  function dialog(title,body){
    let el=document.querySelector('#media-dialog');if(!el){el=document.createElement('dialog');el.id='media-dialog';document.body.append(el)}
    el.innerHTML=`<div class="modal-head"><h2>${escape(title)}</h2>${button('close','关闭')}</div><div class="modal-body">${body}</div>`;
    if(!el.open)el.showModal();return el;
  }
  async function viewer(id,doc,version){
    const a=library.assets.find(a=>a.id===id);if(!a)throw new Error('素材尚未载入，请稍后重试。');
    version=version||doc?.media?.transcriptId||a.transcriptId;
    const transcript=version?await ctx.api('/api/media/transcript?id='+encodeURIComponent(id)+'&version='+encodeURIComponent(version)):null;
    const url='/api/media/file?id='+encodeURIComponent(id)+(version?'&version='+encodeURIComponent(version):'');
    dialog(a.title||'查看视频',`<div class="media-viewer-source"><span>${escape(a.author||'')} · ${escape(a.platformLabel||a.platform||'')}</span><a href="${escape(a.url)}" target="_blank" rel="noopener">打开平台原链接 ↗</a>${button('reveal','定位本地文件',id)}</div><div class="media-viewer"><div><video id="source-video" controls playsinline preload="metadata" src="${escape(url)}"></video><p class="muted small-text">点击右侧时间，跳到原视频核对。${transcript?'时间对应原始转写。':'勾选转文字后可查看带时间轴的口播。'}</p>${a.transcripts.length>1?`<label>转写版本 <select data-media-version="${escape(id)}">${a.transcripts.map((t,i)=>`<option value="${t.id}" ${t.id===version?'selected':''}>第 ${i+1} 版 · ${t.characters} 字</option>`).join('')}</select></label>`:''}${transcript?`<div class="media-downloads">${button('copy-transcript','复制全文',id,`data-version="${escape(version)}"`)}${['txt','srt','json'].map(format=>`<a class="button small" href="/api/media/transcript-file?id=${escape(id)}&version=${escape(version)}&format=${format}">下载 ${format.toUpperCase()}</a>`).join('')}</div>`:''}</div><section class="media-transcript"><h3>原始转写${transcript?' · '+transcript.segments.length+' 个片段':''}</h3><div class="media-segments">${transcript?transcript.segments.map(s=>`<button type="button" class="media-segment" data-media-action="seek" data-ms="${Number(s.start)}"><time>${stamp(s.start)}</time><span>${escape(s.text)}</span></button>`).join(''):'<p>这条视频还没有转写文稿。</p>'}</div></section></div>${doc?`<details class="media-correction"><summary>修订文案 · ${escape(doc.title)}</summary><p>核对视频后在这里修订。保存后沿用原来的精选与组稿更新规则，原始转写单独保留。</p><textarea id="media-correction" aria-label="修订文案" maxlength="40000">${escape(doc.text)}</textarea>${button('save-correction','保存修订稿',id,`data-doc="${escape(doc.id)}" data-topic="${escape(doc.topicId)}"`)}</details>`:''}`);
  }
  function documentContext(id,topicId){
    const s=ctx.state();const topics=[...s.topics,...s.archives.map(a=>a.topic)];
    const t=topics.find(t=>(!topicId||t.id===topicId)&&t.documents.some(d=>d.id===id));const doc=t?.documents.find(d=>d.id===id);return doc?{...doc,topicId:t.id}:null;
  }
  async function control(command,id,payload){await ctx.api('/api/media/control',{command,id,payload});await refresh()}
  async function attach(id,topicId,transcriptId){
    const r=await ctx.api('/api/media/attach',{id,topicId,transcriptId});
    await refresh();await ctx.refresh();ctx.toast(r.message||(r.status==='imported'?'已加入选题，可以开始挑选文案':'已关联选题，转写完成后自动加入'),!!r.message);
  }
  document.addEventListener('input',event=>{
    if(event.target.id==='media-links'){text=event.target.value;intake.schedule()}
    if(event.target.id==='media-search'){query=event.target.value;paint()}
  });
  document.addEventListener('submit',event=>{if(event.target.id==='media-intake-form'){event.preventDefault();void intake.flush()}});
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.id==='media-target'){targetTopic=el.value;paint()}
    if(el.dataset.mediaChoice){
      const id=el.dataset.mediaChoice,enabled=el.checked;optimistic.set(id,enabled);paint();
      void control('transcription-choice',id,{enabled}).catch(e=>ctx.toast(e.message,true)).finally(()=>{optimistic.delete(id);paint()});
    }
    if(el.dataset.mediaVersion)void viewer(el.dataset.mediaVersion,null,el.value).catch(e=>ctx.toast(e.message,true));
  });
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-media-action]');if(!el)return;event.preventDefault();
    void(async()=>{
      const action=el.dataset.mediaAction,id=el.dataset.id;
      if(action==='filter'){filter=id;paint();return}
      if(action==='close'){document.querySelector('#media-dialog').close();return}
      if(action==='seek'){const video=document.querySelector('#source-video');video.currentTime=Number(el.dataset.ms)/1000;await video.play().catch(()=>{});return}
      if(action==='viewer'){await viewer(id);return}
      if(action==='copy-transcript'){const t=await ctx.api('/api/media/transcript?id='+id+'&version='+el.dataset.version);await ctx.copy(t.text);return}
      if(action==='redownload'){const a=library.assets.find(a=>a.id===id);await ctx.api('/api/media/intake',{text:a.url,force:true});await refresh();ctx.toast('已重新加入下载队列，转文字默认不勾选');return}
      if(action==='document'){await refresh();const doc=documentContext(el.dataset.doc,el.dataset.topic);if(!doc?.media)throw new Error('这篇文案没有关联视频。');await viewer(doc.media.assetId,doc);return}
      if(action==='attach'){await attach(id,el.dataset.topic);return}
      if(action==='assign'){
        const a=library.assets.find(a=>a.id===id);dialog('关联到选题',`<p>关联后，已有或之后完成的转写稿会加入该选题；转文字仍由你勾选。</p><label class="form-field">选题<select id="media-assign-topic">${ctx.state().topics.map(t=>`<option value="${escape(t.id)}" ${t.id===(targetTopic||ctx.topicId())?'selected':''}>${escape(t.title)}</option>`).join('')}</select></label>${a.transcripts.length>1?`<label class="form-field">转写版本<select id="media-assign-version">${a.transcripts.map((t,i)=>`<option value="${t.id}" ${t.id===a.transcriptId?'selected':''}>第 ${i+1} 版 · ${t.characters} 字</option>`).join('')}</select></label>`:''}<div class="modal-footer">${button('confirm-assign','确认关联',id)}</div>`);return;
      }
      if(action==='confirm-assign'){const selected=document.querySelector('#media-assign-topic').value;if(!selected)throw new Error('请先创建选题。');await attach(id,selected,document.querySelector('#media-assign-version')?.value);document.querySelector('#media-dialog').close();return}
      if(action==='save-correction'){
        const doc=documentContext(el.dataset.doc,el.dataset.topic);await ctx.flush();await ctx.api('/api/action',{type:'document.update',topicId:doc.topicId,documentId:doc.id,payload:{title:doc.title,source:doc.source,text:document.querySelector('#media-correction').value}});await ctx.refresh();ctx.toast('修订稿已保存，原始转写仍保留');return;
      }
      if(action==='settings'){dialog('海外平台网络设置',`<p>自动识别本机已有网络入口。保留最高原画，包括 4K。</p><label class="form-field">代理地址<input id="media-proxy" aria-label="代理地址" value="${escape(library.settings?.proxy||'auto')}" placeholder="auto / direct / http://127.0.0.1:端口"></label><div class="modal-footer">${button('save-settings','保存设置')}</div>`);return}
      if(action==='save-settings'){await control('settings',null,{proxy:document.querySelector('#media-proxy').value.trim()});document.querySelector('#media-dialog').close();ctx.toast('网络设置已保存');return}
      el.disabled=true;try{await control(action,id,action==='pause'?{paused:!library.paused}:{})}finally{el.disabled=false}
    })().catch(e=>ctx.toast(e.message,true));
  });
  document.addEventListener('close',event=>{if(event.target.id==='media-dialog')event.target.querySelector('video')?.pause()},true);
  return {view,mounted(view){currentView=view;if(view==='media'){paint();void refresh()}},start(){void refresh();timer=setInterval(()=>void refresh(),2000)},stop(){clearInterval(timer);intake.stop()}};
}
