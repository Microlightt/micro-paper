(function(global,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(global)global.MicroPaperOriginalPdf=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function sourceBlob(data){
  if(typeof data!=='string'||!data.startsWith('data:application/pdf;base64,'))throw Error('原始 PDF 数据不可用');
  const binary=atob(data.slice(data.indexOf(',')+1)),parts=[];
  if(!/%PDF-\d\.\d/.test(binary.slice(0,1024)))throw Error('原始 PDF 数据格式无效');
  for(let start=0;start<binary.length;start+=32768){const part=binary.slice(start,start+32768),bytes=new Uint8Array(part.length);for(let i=0;i<part.length;i++)bytes[i]=part.charCodeAt(i);parts.push(bytes);}
  return new Blob(parts,{type:'application/pdf'});
 }
 function create({paper,frame,fallback,loading,downloadLink}={}){
  if(!paper||!frame||!fallback||!loading)throw TypeError('Original PDF requires paper and viewer elements');
  let url=null,blob=null,started=false,fallbackReady=false,destroyed=false,targetPageId=null,pendingScroll=null;
  const urls=new Set();
  const doc=frame.ownerDocument,win=doc.defaultView||globalThis;
  if(downloadLink){downloadLink.href=paper.sourcePdf;downloadLink.download='source.pdf';}
  function releaseUrls(keep=null){for(const value of urls)if(value!==keep){win.URL.revokeObjectURL(value);urls.delete(value);}}
  function stopNative(){
   const hadUrl=urls.size>0;releaseUrls();url=null;blob=null;
   if(hadUrl)frame.src='about:blank';
  }
  function scrollFallback(){
   if(destroyed||!targetPageId)return;
   if(pendingScroll!==null)win.cancelAnimationFrame(pendingScroll);
   pendingScroll=win.requestAnimationFrame(()=>{pendingScroll=null;if(destroyed)return;doc.getElementById('original-pdf-'+targetPageId)?.scrollIntoView({block:'start'});});
  }
  function showFallback(){
   if(destroyed)return;
   stopNative();
   frame.hidden=true;fallback.hidden=false;loading.hidden=true;fallback.dataset.viewerMode='continuous-pages';
   if(!fallbackReady){fallbackReady=true;
    for(const page of paper.pages){const section=doc.createElement('figure'),img=doc.createElement('img'),caption=doc.createElement('figcaption');section.className='original-pdf-page';section.dataset.pageId=page.pageId;section.id='original-pdf-'+page.pageId;img.className='source-page-image';img.src=page.asset;img.alt='原 PDF 第 '+page.number+' 页';img.loading='lazy';img.decoding='async';img.width=page.width;img.height=page.height;caption.textContent=page.number+' / '+paper.pages.length;section.append(img,caption);fallback.append(section);}
   }
   scrollFallback();
  }
  function loadNative(page){
   loading.hidden=false;frame.hidden=false;fallback.hidden=true;
   try{
    if(!blob)blob=sourceBlob(paper.sourcePdf);
    // Chrome's PDF viewer does not reliably consume fragment-only changes.
    // A fresh resource URL reloads standard #page navigation, with one decoded Blob.
    url=win.URL.createObjectURL(blob);urls.add(url);
    frame.dataset.viewerMode='native-pdf';frame.dataset.pageCount=String(paper.pages.length);
    if(page)frame.dataset.targetPage=String(page.number);
    frame.src=url+'#'+(page?'page='+page.number+'&':'')+'view=FitH&navpanes=0';
   }catch(_){showFallback();}
  }
  function ensure(){
   if(started||destroyed)return;started=true;
   if(win.navigator.pdfViewerEnabled===false){showFallback();return;}
   loadNative(paper.pages.find(page=>page.pageId===targetPageId));
  }
  function showPage(pageId){
   const page=paper.pages.find(p=>p.pageId===pageId);if(!page||destroyed)return;
   targetPageId=pageId;
   if(!started){ensure();return;}
   if(!frame.hidden&&url)loadNative(page);
   else scrollFallback();
  }
  const loaded=()=>{if(destroyed||frame.hidden||!url)return;loading.hidden=true;releaseUrls(url);};frame.addEventListener('load',loaded);frame.addEventListener('error',showFallback);
  return{ensure,showPage,showFallback,destroy(){destroyed=true;frame.removeEventListener('load',loaded);frame.removeEventListener('error',showFallback);if(pendingScroll!==null)win.cancelAnimationFrame(pendingScroll);stopNative();}};
 }
 return{create,sourceBlob};
});
