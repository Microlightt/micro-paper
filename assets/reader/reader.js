(()=>{'use strict';
const originalHtml='<!doctype html>\n'+document.documentElement.outerHTML;
const P=JSON.parse(document.getElementById('paper-data').textContent),$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const B=new Map(P.blocks.map(b=>[b.blockId,b])),F=new Map(P.figures.map(f=>[f.figureId,f]));
const KEY='micro-paper:notes:v1:'+P.documentId+':'+P.sourceSha256;
let articleInfo,columns,sourcePdf,toc,selectionTools,articleSearch,readingFont,referenceLinks;
let languageBeforeSearchReveal=null;
const presentation=window.MicroPaperPresentation.createIndex(P);
let captionOverride=null;
P.readerSettings={...P.readerSettings,figureScaleSchema:3,figureInitialScale:1};
const images=createImageInteractions();
let embeddedSnapshots=[],records=[],language='both',view='reader',pending=null,editing=null,importPlan=null,pinned=false,currentFigure=null,candidates=[],rawRecovery=null,storageBlocked=false,manualHold=false;
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
const now=()=>new Date().toISOString();
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
function toast(s){$('#toast').textContent=s;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,4500)}
function warning(s){$('#storage-warning').hidden=false;if(s)$('#storage-warning').textContent=s}
function envelope(){return window.MicroPaperNotesState.createEnvelope({paper:P,annotations:records,exportedAt:now(),embeddedSnapshots})}
function portableEnvelope(){const snapshotId=uid();embeddedSnapshots=[...new Set([...embeddedSnapshots,snapshotId])];const snapshot={...envelope(),snapshotId};persist();return snapshot;}
function persist(){if(storageBlocked){warning('已有损坏的存储记录被保留。请先导出原始 JSON；本次笔记保留在内存。');return false}try{localStorage.setItem(KEY,JSON.stringify(envelope()));$('#storage-warning').hidden=true;return true}catch(e){warning();return false}}
function download(name,body,mime){const a=node('a');a.href=URL.createObjectURL(new Blob([body],{type:mime}));a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1500)}
function figureName(id){const f=F.get(id);return f?(f.scope==='extended'?'Extended Data Fig. ':f.scope==='supplement'?'Supplementary Fig. ':'Fig. ')+f.number:id}
function rangeValid(s,start,end){if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>s.length)return false;return ![start,end].some(i=>i>0&&i<s.length&&/[\uD800-\uDBFF]/.test(s[i-1])&&/[\uDC00-\uDFFF]/.test(s[i]))}
function refs(bid,lang){return P.inlineReferences.filter(r=>r.blockId===bid&&r.language===lang)}
function renderText(b,lang,interactive=true,suppressedRanges=[]){
 const el=node('p',undefined,'prose');el.dataset.blockId=b.blockId;el.dataset.language=lang;
 const text=b[lang]||'〔待翻译〕',formats=P.formatting.filter(f=>f.blockId===b.blockId&&f.language===lang),links=refs(b.blockId,lang),citations=referenceLinks?.forBlock(b.blockId,lang)||[],anns=records.filter(a=>a.status==='located'&&a.blockId===b.blockId&&a.language===lang);
 const boundaries=new Set([0,text.length]);for(const f of [...formats,...links,...links.flatMap(r=>r.targets||[]),...anns,...citations,...suppressedRanges])if(rangeValid(text,f.start,f.end)){boundaries.add(f.start);boundaries.add(f.end)}
 const points=[...boundaries].sort((a,b)=>a-b);
 for(let i=0;i<points.length-1;i++){
  const start=points[i],end=points[i+1],value=text.slice(start,end);if(!value)continue;
  let n=document.createTextNode(value);
  for(const f of formats.filter(f=>f.start<=start&&f.end>=end)){const w=node(f.kind==='italic'?'em':f.kind==='sup'?'sup':'sub');w.append(n);n=w}
  const ref=links.find(f=>f.start<=start&&f.end>=end);
  if(ref&&interactive){const target=(ref.targets||[]).find(t=>t.start<=start&&t.end>=end),ids=target?.figureIds||ref.figureIds;const w=node('span',undefined,'figure-ref');w.tabIndex=0;w.setAttribute('role','button');w.dataset.figures=JSON.stringify(ids);w.dataset.panels=JSON.stringify(ref.panelLabels||[]);w.setAttribute('aria-label','查看 '+ids.map(figureName).join(', '));w.append(n);n=w}
  const ann=anns.find(f=>f.start<=start&&f.end>=end);if(ann&&interactive){const w=node('mark');w.dataset.annotationId=ann.annotationId;w.dataset.color=ann.color;w.title=ann.note||'编辑高亮';w.append(n);n=w}
  const citation=citations.find(f=>f.start<=start&&f.end>=end);if(citation&&interactive)n=referenceLinks.wrapFragment(n,citation,start,end);
  if(suppressedRanges.some(f=>f.start<=start&&f.end>=end)){const w=node('span',undefined,'info-duplicate-value');w.hidden=true;w.append(n);n=w}
  el.append(n);
 }
 if(el.textContent!==text)throw Error('Rendered text differs from canonical string');
 return el;
}
function sourceButton(b){
 const pages=[...new Set(b.sourceSpans.map(s=>s.pageId))],source=node('button','原页 '+pages.map(id=>P.pages.find(p=>p.pageId===id)?.number).join(', '),'source-link');source.onclick=()=>showPage(pages[0]);return source;
}
function canonicalBlock(b){
 const wrap=node('div',undefined,'block '+b.kind);wrap.id=b.blockId;wrap.dataset.blockId=b.blockId;
 if(b.kind==='heading'){wrap.setAttribute('role','heading');wrap.setAttribute('aria-level','2')}
 wrap.append(renderText(b,'en'),renderText(b,'zh'),sourceButton(b));return wrap;
}
function sectionTitle(section){
 const title=node('h2',undefined,'section-title');title.append(node('span',section.titleEn,'section-title-en'),node('span',section.titleZh||section.titleEn,'section-title-zh'));return title;
}
function renderCaptions(){
 const pool=$('#figure-caption-content');pool.replaceChildren();pool.className='figure-caption language-'+language;
 for(const b of presentation.captions)pool.append(canonicalBlock(b));
 updateCaptionVisibility();
}
function updateCaptionVisibility(){
 const ids=new Set(presentation.captionIdsForFigure(currentFigure));if(captionOverride)ids.add(captionOverride);
 for(const wrap of $$('#figure-caption-content .block'))wrap.hidden=!ids.has(wrap.dataset.blockId);
 $('#figure-caption-content').hidden=ids.size===0;
 $('#caption-unassigned').hidden=!captionOverride||presentation.ownersFor(captionOverride).length>0;
 articleSearch?.refresh();selectionTools?.refresh();
}
function renderArticle(){
 selectionTools?.hide();referenceLinks?.close();
 const a=$('#article');a.replaceChildren();a.className='language-'+language;
 for(const section of P.sections){
  const compact=articleInfo?.render(section,language);if(compact){a.append(compact);continue}
  if(presentation.captionOnly(section))continue;
  const sec=node('section');sec.id=section.sectionId;
  if(!presentation.matchingHeading(section))sec.append(sectionTitle(section));
  for(const bid of section.blockIds){const b=B.get(bid);if(!b||['figure-label','header-footer'].includes(b.kind))continue;
   if(b.kind==='caption')continue;sec.append(canonicalBlock(b));
  }a.append(sec);
 }renderCaptions();$('#note-count').textContent=records.length;articleSearch?.refresh();queueFollow();
}
function navigateTo(id){
 const section=P.sections.find(s=>s.sectionId===id);if(section)id=presentation.sectionTarget(section);
 if(B.get(id)?.kind==='caption'){
  const owners=presentation.ownersFor(id),selected=owners.includes(currentFigure)?currentFigure:owners[0];
  if(selected)showFigure(selected,true);else{manualHold=true;clearTimeout(followTimer);followPending=null;captionOverride=id;updateCaptionVisibility()}
  if(innerWidth<=800){$('#figure-pane').classList.add('open');$('#figure-toggle').setAttribute('aria-expanded','true');images.fitFigure()}
  const target=document.getElementById(id);if(!target)return;
  requestAnimationFrame(()=>{measureToolbar();const pane=$('#figure-pane'),controls=$('.figure-controls'),pr=pane.getBoundingClientRect(),tr=target.getBoundingClientRect();pane.scrollTop=Math.max(0,pane.scrollTop+tr.top-pr.top-controls.getBoundingClientRect().height-14)});return;
 }
 const target=document.getElementById(id);if(!target)return;
 articleInfo?.revealBlock(id,$('#article'));
 for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
 requestAnimationFrame(()=>{measureToolbar();target.scrollIntoView({block:'start'});queueFollow()});
}
function closeFigurePane(){
 $('#figure-pane').classList.remove('open');$('#figure-toggle').setAttribute('aria-expanded','false');$('#figure-toggle').focus({preventScroll:true});measureToolbar();
}
function toggleFigurePane(){
 const open=!$('#figure-pane').classList.contains('open');$('#figure-pane').classList.toggle('open',open);$('#figure-toggle').setAttribute('aria-expanded',String(open));measureToolbar();if(open)images.fitFigure();
}
function setLanguage(lang){referenceLinks?.close();selectionTools?.hide();const activeCaption=captionOverride;language=lang;$$('[data-language]').filter(x=>x.tagName==='BUTTON').forEach(x=>x.classList.toggle('active',x.dataset.language===lang));$('#title').textContent=lang==='en'?P.metadata.titleEn:P.metadata.titleZh||P.metadata.titleEn;renderArticle();if(currentFigure)showFigure(currentFigure,false);if(activeCaption){captionOverride=activeCaption;updateCaptionVisibility();if(view==='reader')navigateTo(activeCaption)}measureToolbar()}
function setView(v){referenceLinks?.close();view=v;for(const name of ['reader','source','notes'])$('#'+name+'-view').hidden=v!==name;$$('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===v));$('#sidebar').classList.remove('open');$('#menu').setAttribute('aria-expanded','false');selectionTools?.hide();if(v==='notes')renderNotes();if(v==='source')sourcePdf?.ensure();columns?.refresh();articleSearch?.refresh();queueFollow()}
function showPage(pid){if(!P.pages.some(p=>p.pageId===pid))return;sourcePdf.showPage(pid);setView('source')}
function renderCandidates(){const list=$('#figure-candidates');list.replaceChildren();const other=candidates.length>1?candidates.filter(id=>id!==currentFigure):[];list.hidden=other.length===0;for(const id of other){const button=node('button',figureName(id));button.dataset.figureId=id;button.onclick=()=>showFigure(id,true);list.append(button)}}
function showCandidates(ids,context,panels=[]){delete $('#figure-candidates').dataset.followKey;candidates=[...new Set(ids.filter(id=>F.has(id)))];renderCandidates()}
function showFigure(id,manual=false){
 const f=F.get(id);if(!f)return;if(manual)manualHold=true;currentFigure=id;$('#figure-select').value=id;const content=$('#figure-content');content.replaceChildren();const viewport=node('div',undefined,'figure-viewport');viewport.tabIndex=0;viewport.setAttribute('aria-label',figureName(id)+' 图片区域');const img=node('img');img.src=f.asset;img.alt=figureName(id)+' · 原图英文保留';viewport.append(img);content.append(viewport);img.addEventListener('load',()=>{if(img.isConnected){measureFigureViewport();images.refresh()}},{once:true});images.mountFigure(viewport,img,id);if(manual)images.fitFigure();
 captionOverride=null;updateCaptionVisibility();renderCandidates();$('#figure-pane').scrollTop=0;requestAnimationFrame(measureFigureViewport);
 if(manual&&innerWidth<=800){$('#figure-pane').classList.add('open');$('#figure-toggle').setAttribute('aria-expanded','true')}
}
function clickReference(link){const ids=JSON.parse(link.dataset.figures),panels=JSON.parse(link.dataset.panels);showCandidates(ids,'当前显式引用',panels);showFigure(ids[0],true)}
let followFrame=0,followTimer=0,followPending=null,followBlock=null;
function queueFollow(){if(followFrame)return;followFrame=requestAnimationFrame(()=>{followFrame=0;follow()})}
function follow(){
 if(pinned||manualHold||view!=='reader'||$$('dialog[open]').length||!$('#selection-tools').hidden||referenceLinks?.isOpen())return;
 const nodes=$$('#article .block'),top=Math.max(0,$('.toolbar').getBoundingClientRect().bottom),anchor=(top+innerHeight)/2;
 let index=nodes.findIndex(n=>n.getBoundingClientRect().bottom>anchor);if(index<0)index=nodes.length-1;
 let source=null,refsForBlock=[];
 for(let i=index;i>=0;i--){const r=P.inlineReferences.filter(r=>r.blockId===nodes[i]?.dataset.blockId&&r.language===(language==='zh'?'zh':'en'));if(r.some(r=>r.figureIds.some(id=>F.has(id)))){source=nodes[i];refsForBlock=r;break}}
 if(!source){clearTimeout(followTimer);followPending=null;return}
 const ids=[...new Set(refsForBlock.flatMap(r=>r.figureIds))].filter(id=>F.has(id)),bid=source.dataset.blockId;
 // A small boundary band and dwell time avoid swapping while the midpoint skims a paragraph edge.
 if(followBlock&&bid!==followBlock&&Math.abs(source.getBoundingClientRect().top-anchor)<32){clearTimeout(followTimer);followPending=null;return}
 if(ids.includes(currentFigure)){
  clearTimeout(followTimer);followPending=null;followBlock=bid;
  const key=JSON.stringify([bid,ids]);if($('#figure-candidates').dataset.followKey!==key){showCandidates(ids,'正文视口中部对应的显式引用',refsForBlock.flatMap(r=>r.panelLabels||[]));$('#figure-candidates').dataset.followKey=key}
  $('#figure-pane').dataset.followBlockId=bid;return;
 }
 if(followPending===bid)return;
 clearTimeout(followTimer);followPending=bid;
 followTimer=setTimeout(()=>{followPending=null;if(pinned||manualHold||view!=='reader'||$$('dialog[open]').length||!$('#selection-tools').hidden||referenceLinks?.isOpen())return;followBlock=bid;showCandidates(ids,'正文视口中部对应的显式引用',refsForBlock.flatMap(r=>r.panelLabels||[]));$('#figure-candidates').dataset.followKey=JSON.stringify([bid,ids]);$('#figure-pane').dataset.followBlockId=bid;showFigure(ids[0]);queueFollow()},140);
}
function openZoom(asset){images.openZoom(asset)}
function annotationFromRange(range){
 const parent=n=>n.nodeType===3?n.parentElement:n,a=parent(range.startContainer)?.closest('.prose'),b=parent(range.endContainer)?.closest('.prose');
 if(!a||a!==b||!a.closest('#reader-view'))return null;
 const before=range.cloneRange();before.selectNodeContents(a);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length,quote=range.toString(),text=B.get(a.dataset.blockId)?.[a.dataset.language];
 if(typeof text!=='string'||!quote.trim()||!rangeValid(text,start,start+quote.length)||text.slice(start,start+quote.length)!==quote)return null;
 return{blockId:a.dataset.blockId,language:a.dataset.language,start,end:start+quote.length,quote,prefix:text.slice(Math.max(0,start-32),start),suffix:text.slice(start+quote.length,start+quote.length+32),color:'yellow',note:'',status:'located',sourceSha256:P.sourceSha256,sourceDocumentId:P.documentId};
}
async function createAnnotation(a){const text=B.get(a.blockId)[a.language];return{...a,annotationId:uid(),textHash:await hash(text),createdAt:now(),updatedAt:now()}}
async function addHighlight(annotation,color){if(!annotation)return;const a=await createAnnotation({...annotation,color});records.push(a);pending=null;window.getSelection()?.removeAllRanges();selectionTools?.hide();const saved=persist();renderArticle();toast(saved?'高亮已保存':'高亮在内存中，请导出备份')}
function openNote(a){if(!a)return;selectionTools?.hide();editing={...a};$('#note-quote').textContent=a.quote;$('#note-text').value=a.note||'';$('#note-color').value=a.color||'yellow';$('#delete-note').hidden=!a.annotationId;$('#selection-tools').hidden=true;$('#note-dialog').showModal();$('#note-text').focus()}
async function saveNote(e){e.preventDefault();let a={...editing,note:$('#note-text').value,color:$('#note-color').value,updatedAt:now()};if(!a.annotationId){a=await createAnnotation(a);records.push(a)}else records=records.map(r=>r.annotationId===a.annotationId?a:r);const saved=persist();$('#note-dialog').close();pending=null;window.getSelection().removeAllRanges();renderArticle();renderNotes();toast(saved?'笔记已保存':'笔记在内存中，请导出备份')}
function renderNotes(){const list=$('#notes-list');list.replaceChildren();$('#note-count').textContent=records.length;if(!records.length)list.append(node('p','选中文字即可划线或写笔记。'));
 for(const a of records){const card=node('div',undefined,'note-card');card.dataset.annotationId=a.annotationId;card.dataset.color=a.color;card.append(node('small',a.blockId+' · '+a.language));if(a.status!=='located')card.append(node('p','待重新定位：'+(a.reason||'位置无法核实'),'note-state'));if(a.conflictOf)card.append(node('p','冲突副本 · '+a.conflictOf,'note-state'));card.append(node('blockquote',a.quote),node('p',a.note||''));const edit=node('button','编辑');edit.onclick=()=>openNote(a);card.append(edit);if(a.status==='located'){const jump=node('button','回到原文');jump.onclick=()=>{setView('reader');setLanguage(a.language);navigateTo(a.blockId)};card.append(jump)}list.append(card)}
}
function sanitize(a){return window.MicroPaperNotesState.sanitizeAnnotation(a)}
async function locate(a,backup){a={...a,sourceSha256:a.sourceSha256||backup.sourceSha256,sourceDocumentId:a.sourceDocumentId||backup.documentId};const unresolved=reason=>({...a,status:'unresolved',reason});if(a.sourceSha256!==P.sourceSha256||a.sourceDocumentId!==P.documentId||backup.sourceSha256!==P.sourceSha256||backup.documentId!==P.documentId)return unresolved('来源或论文身份不同，原记录保留');
 const b=B.get(a.blockId),text=b?.[a.language];
 if(typeof text==='string'){
  if(rangeValid(text,a.start,a.end)&&text.slice(a.start,a.end)===a.quote){return{...a,status:'located',reason:undefined,textHash:await hash(text)}}
  const matches=[];for(let pos=text.indexOf(a.quote);pos>=0;pos=text.indexOf(a.quote,pos+1)){if(rangeValid(text,pos,pos+a.quote.length)&&(!a.prefix||text.slice(Math.max(0,pos-a.prefix.length),pos)===a.prefix)&&(!a.suffix||text.slice(pos+a.quote.length,pos+a.quote.length+a.suffix.length)===a.suffix))matches.push(pos)}
  if(matches.length===1){const start=matches[0];return{...a,start,end:start+a.quote.length,status:'located',reason:undefined,textHash:await hash(text)}}
 }
 const maps=P.idMap.filter(m=>m.oldBlockId===a.blockId&&m.language===a.language&&m.oldStart<=a.start&&m.oldEnd>=a.end&&m.oldEnd-m.oldStart===m.newEnd-m.newStart&&m.oldText===m.newText&&m.oldText.slice(a.start-m.oldStart,a.end-m.oldStart)===a.quote);
 const verified=[];for(const m of maps){const t=B.get(m.newBlockId)?.[a.language],start=m.newStart+a.start-m.oldStart,end=start+a.quote.length;if(typeof t==='string'&&t.slice(m.newStart,m.newEnd)===m.newText&&rangeValid(t,start,end)&&t.slice(start,end)===a.quote)verified.push({...a,blockId:m.newBlockId,start,end,status:'located',reason:undefined,textHash:await hash(t)})}
 return verified.length===1?verified[0]:unresolved('文本改变、多个匹配或没有可核验字符映射');
}
const equalRecord=(a,b)=>['blockId','language','start','end','quote','prefix','suffix','color','note','createdAt','updatedAt','sourceSha256','sourceDocumentId'].every(k=>a[k]===b[k]);
async function planImport(backup){if(backup.format!=='micro-paper-notes'||backup.schemaVersion!==1||typeof backup.documentId!=='string'||typeof backup.sourceSha256!=='string'||typeof backup.contentFingerprint!=='string'||!Array.isArray(backup.annotations))throw Error('不支持的备份格式或缺少来源身份');const result={add:[],duplicates:0,conflicts:0,unresolved:0};const seen=new Map(records.map(a=>[a.annotationId,a]));
 for(const raw of backup.annotations){let a=await locate(sanitize(raw),backup);const old=seen.get(a.annotationId);if(old&&equalRecord(old,a)){result.duplicates++;continue}if(old){a={...a,annotationId:uid(),conflictOf:a.annotationId};result.conflicts++}if(a.status!=='located')result.unresolved++;result.add.push(a);seen.set(a.annotationId,a)}return result;
}
async function importFile(file){if(!file)return;try{if(file.size>20*1024*1024)throw Error('备份超过 20 MiB');importPlan=await planImport(JSON.parse(await file.text()));$('#import-preview').textContent='新增 '+importPlan.add.length+' 条 · 重复 '+importPlan.duplicates+' 条 · 冲突 '+importPlan.conflicts+' 条 · 待定位 '+importPlan.unresolved+' 条';$('#import-dialog').showModal()}catch(e){toast('导入失败：'+e.message)}finally{$('#import-file').value=''}}
function exportJson(){download('micro-paper-notes.json',JSON.stringify(envelope(),null,2),'application/json');if(rawRecovery)download('micro-paper-storage-recovery.json',rawRecovery,'application/json');toast('JSON 备份已下载')}
function exportMd(){let md='# 阅读笔记\n\n'+P.metadata.titleEn+'\n\n';for(const a of records)md+='## '+a.blockId+' · '+a.language+' · '+(a.status==='located'?'已定位':'待定位')+(a.conflictOf?' · 冲突副本':'')+'\n\n'+a.quote.split('\n').map(v=>'> '+v).join('\n')+'\n\n'+a.note+'\n\n';download('micro-paper-notes.md',md,'text/markdown')}
function measureFigureViewport(){
 const viewport=$('#figure-content .figure-viewport'),pane=$('#figure-pane'),img=viewport?.querySelector('img');if(!viewport||!pane.getClientRects().length)return;
 const pr=pane.getBoundingClientRect(),vr=viewport.getBoundingClientRect(),st=getComputedStyle(pane),toolbarBottom=$('.toolbar').getBoundingClientRect().bottom;
 const paneMaximum=Math.max(128,innerHeight-Math.max(pr.top,toolbarBottom+8)-12)+'px';if(pane.style.maxHeight!==paneMaximum)pane.style.maxHeight=paneMaximum;
 const available=Math.max(64,innerHeight-Math.max(pr.top,toolbarBottom+8)-(vr.top-pr.top+pane.scrollTop)-18);
 const width=Math.max(1,pane.clientWidth-parseFloat(st.paddingLeft)-parseFloat(st.paddingRight)),vs=getComputedStyle(viewport);
 const borderX=(parseFloat(vs.borderLeftWidth)||0)+(parseFloat(vs.borderRightWidth)||0),borderY=(parseFloat(vs.borderTopWidth)||0)+(parseFloat(vs.borderBottomWidth)||0);
 const ratio=img?.naturalWidth>0?img.naturalHeight/img.naturalWidth:1,idealHeight=Math.max(1,width-borderX)*ratio+borderY;
 const maximum=Math.max(64,Math.min(innerHeight*.68,available-48)),height=Math.min(idealHeight,maximum);
 for(const [key,value] of [['width','100%'],['height',height+'px'],['maxHeight','none'],['aspectRatio','auto']])if(viewport.style[key]!==value)viewport.style[key]=value;
}
function measureToolbar(){
 const rect=$('.toolbar').getBoundingClientRect(),style=document.documentElement.style;
 style.setProperty('--toolbar',rect.height+'px');style.setProperty('--toolbar-bottom',Math.max(0,rect.bottom)+'px');measureFigureViewport();queueFollow();
}
async function init(){
 referenceLinks=window.MicroPaperReferenceLinks.create({paper:P,root:$('#reader-view'),toolbar:$('.toolbar'),navigateTo:blockId=>{setView('reader');if(innerWidth<=800){$('#figure-pane').classList.remove('open');$('#figure-toggle').setAttribute('aria-expanded','false')}navigateTo(blockId);history.replaceState(null,'','#'+encodeURIComponent(blockId))},onError:()=>toast('参考文献位置无法核实，请查看原页')});
 document.title=P.metadata.titleEn;articleInfo=window.MicroPaperArticleInfo.createArticleInfo({paper:P,node,renderText,blocksById:B,sourceButton});
 sourcePdf=window.MicroPaperOriginalPdf.create({paper:P,frame:$('#source-pdf-frame'),fallback:$('#source-pages'),loading:$('#source-pdf-loading'),downloadLink:$('#original-pdf')});
 toc=window.MicroPaperToc.render($('#toc'),P,targetId=>{setView('reader');navigateTo(targetId);history.replaceState(null,'','#'+encodeURIComponent(targetId))});
 for(const f of P.figures){const opt=node('option',figureName(f.figureId));opt.value=f.figureId;$('#figure-select').append(opt)}
 let local=null,embedded=null;
 try{const raw=localStorage.getItem(KEY);if(raw){rawRecovery=raw;local=JSON.parse(raw);window.MicroPaperNotesState.validateEnvelope(local)}}catch(e){storageBlocked=true;warning('本地存储不可读取或记录损坏；原记录不会被覆盖，请导出备份。')}
 try{embedded=JSON.parse($('#embedded-notes').textContent);if(embedded&&!embedded.snapshotId)embedded.snapshotId='legacy-'+await hash(JSON.stringify(embedded))}catch(e){warning('内嵌笔记无法读取；请保留当前 HTML 并使用 JSON 备份。')}
 const merged=await window.MicroPaperNotesState.mergeEnvelopes({paper:P,embedded,local,locate,uid});records=merged.annotations;embeddedSnapshots=merged.embeddedSnapshots;
 if(merged.errors.some(e=>e.source==='local')){storageBlocked=true;warning('部分本地记录损坏；原记录不会被覆盖，请导出备份。')}else if(!storageBlocked)rawRecovery=null;
 if(merged.errors.some(e=>e.source==='embedded'))warning('部分内嵌笔记无法核实，请保留 HTML 并导出备份。');
 if(embedded&&records.length&&!storageBlocked)persist();
 setLanguage('both');setView('reader');if(P.figures.length)showFigure(P.figures[0].figureId);
 $$('[data-language]').filter(x=>x.tagName==='BUTTON').forEach(b=>b.onclick=()=>{languageBeforeSearchReveal=null;setLanguage(b.dataset.language)});$$('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
 $('#menu').onclick=()=>{$('#sidebar').classList.toggle('open');$('#menu').setAttribute('aria-expanded',$('#sidebar').classList.contains('open'))};$('#figure-toggle').onclick=toggleFigurePane;$('#figure-close').onclick=closeFigurePane;
 $('#figure-select').onchange=e=>{showCandidates([e.target.value],'手动选图');showFigure(e.target.value,true)};$('#pin').onclick=()=>{pinned=!pinned;$('#pin').setAttribute('aria-pressed',pinned);$('#pin').textContent=pinned?'已固定':'固定';if(!pinned){manualHold=false;queueFollow()}};$('#zoom').onclick=()=>{if(currentFigure)openZoom(F.get(currentFigure).asset)};
 $$('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
 $('#note-form').onsubmit=saveNote;$('#delete-note').onclick=()=>{records=records.filter(a=>a.annotationId!==editing.annotationId);persist();$('#note-dialog').close();renderArticle();renderNotes()};$('#note-dialog').addEventListener('close',()=>{editing=null;pending=null});
 selectionTools=window.MicroPaperSelectionTools.create({element:$('#selection-tools'),reader:$('#reader-view'),toolbar:$('.toolbar'),readSelection:annotationFromRange,isEnabled:()=>view==='reader'&&!document.querySelector('dialog[open]'),onHighlight:addHighlight,onNote:openNote,onError:()=>toast('操作未保存，请重试')});
 // Chromium suppresses mouse selection starting inside a focusable inline span.
 // Keep keyboard tab stops, but defer pointer focus until a click is established.
 $('#reader-view').addEventListener('pointerdown',e=>{const link=e.target.closest('.figure-ref');if(!link)return;link.removeAttribute('tabindex');const restore=()=>{link.tabIndex=0;document.removeEventListener('pointerup',restore);document.removeEventListener('pointercancel',restore);window.removeEventListener('blur',restore)};document.addEventListener('pointerup',restore);document.addEventListener('pointercancel',restore);window.addEventListener('blur',restore)});
 $('#reader-view').addEventListener('click',e=>{if(window.getSelection()?.toString())return;const mark=e.target.closest('[data-annotation-id]');if(mark){openNote(records.find(a=>a.annotationId===mark.dataset.annotationId));return}const link=e.target.closest('.figure-ref');if(link){clickReference(link);link.focus({preventScroll:true})}});$('#reader-view').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.matches('.figure-ref')){e.preventDefault();clickReference(e.target)}});
 $('#export-json').onclick=exportJson;$('#export-md').onclick=exportMd;$('#import-json').onclick=()=>$('#import-file').click();$('#import-file').onchange=e=>importFile(e.target.files[0]);$('#confirm-import').onclick=()=>{records.push(...importPlan.add);persist();$('#import-dialog').close();renderArticle();renderNotes();toast('已合并并保留冲突及待定位记录')};
 const exporter=window.MicroPaperExportNames.createExportNames({paper:P,originalHtml,download,toast,getEnvelope:portableEnvelope});$('#download-html').onclick=exporter.open;
 const resumeFollow=e=>{if(view==='reader'&&!$$('dialog[open]').length&&!e.target.closest?.('#figure-pane, input, textarea, select, button, #sidebar')){manualHold=false;queueFollow()}};window.addEventListener('wheel',resumeFollow,{passive:true});window.addEventListener('touchmove',resumeFollow,{passive:true});window.addEventListener('keydown',e=>{if(['PageDown','PageUp','Home','End','ArrowDown','ArrowUp',' '].includes(e.key))resumeFollow(e)});window.addEventListener('scroll',measureToolbar,{passive:true});window.addEventListener('resize',()=>{measureToolbar();images.refresh()});new ResizeObserver(measureToolbar).observe($('.toolbar'));new ResizeObserver(measureFigureViewport).observe($('#figure-pane'));measureToolbar();
 columns=window.MicroPaperColumns.create({root:document.querySelector('main'),reader:$('#reader-view'),settings:P.readerSettings?.columnLayout,onResize:()=>{measureToolbar();images.refresh();queueFollow()}});
 articleSearch=window.MicroPaperArticleSearch.create({paper:P,container:$('#article-search'),root:$('#reader-view'),reveal:match=>{setView('reader');if(language!=='both'){if(languageBeforeSearchReveal===null)languageBeforeSearchReveal=language;setLanguage('both')}navigateTo(match.blockId)},onClear:()=>{if(languageBeforeSearchReveal!==null){const originalLanguage=languageBeforeSearchReveal;languageBeforeSearchReveal=null;setLanguage(originalLanguage)}},onLayout:measureToolbar});
 readingFont=window.MicroPaperReadingFont.create({paper:P,decreaseButton:$('#reading-font-decrease'),increaseButton:$('#reading-font-increase'),status:$('#reading-font-status'),article:$('#article'),legend:$('#figure-caption-content'),figurePane:$('#figure-pane'),toolbar:$('.toolbar'),measureToolbar,refreshImages:()=>images.refresh(),queueFollow,onChange:size=>{P.readerSettings={...P.readerSettings,readingFontSize:size};selectionTools?.refresh();articleSearch?.refresh()},onStorageError:()=>toast('本次字号已调整；浏览器无法保存字号偏好。')});
 window.addEventListener('hashchange',()=>{if(location.hash){setView('reader');navigateTo(decodeURIComponent(location.hash.slice(1)))}});
 if(location.hash)navigateTo(decodeURIComponent(location.hash.slice(1)));
 window.microPaper={ready:true};
}
init().catch(e=>{warning('阅读器初始化失败：'+e.message);console.error(e)});
})();
