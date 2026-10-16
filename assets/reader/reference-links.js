(function(global,factory){
  'use strict';const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(global)global.MicroPaperReferenceLinks=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const blockKey=(blockId,language)=>JSON.stringify([blockId,language]);
  const positive=value=>Number.isInteger(value)&&value>0;
  const evidence=value=>typeof value==='string'?!!value.trim():Array.isArray(value)?value.length>0:!!value&&typeof value==='object'&&Object.keys(value).length>0;
  function validRange(text,start,end){
    return typeof text==='string'&&Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=text.length&&![start,end].some(i=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])&&/[\uDC00-\uDFFF]/.test(text[i]));
  }
  function createIndex(paper={}){
    const blocks=new Map((Array.isArray(paper?.blocks)?paper.blocks:[]).filter(block=>block&&typeof block.blockId==='string').map(block=>[block.blockId,block])),diagnostics=[],byNumber=new Map(),byBlock=new Map(),byId=new Map();
    const reject=(kind,index,reason)=>diagnostics.push({kind,index,reason});
    const targets=[];
    for(const [index,target] of (Array.isArray(paper?.referenceTargets)?paper.referenceTargets:[]).entries()){
      if(!target||!positive(target.number)||typeof target.blockId!=='string'||blocks.get(target.blockId)?.kind!=='reference'||!evidence(target.sourceEvidence)){reject('target',index,'invalid-target-or-source-evidence');continue;}
      targets.push({...target,index});
    }
    for(const target of targets){
      if(targets.some(other=>other!==target&&(other.number===target.number||other.blockId===target.blockId))){reject('target',target.index,'ambiguous-target');continue;}
      const block=blocks.get(target.blockId);byNumber.set(target.number,Object.freeze({number:target.number,blockId:target.blockId,text:typeof block.en==='string'?block.en:typeof block.zh==='string'?block.zh:''}));
    }
    for(const [index,raw] of (Array.isArray(paper?.referenceCitations)?paper.referenceCitations:[]).entries()){
      const block=blocks.get(raw?.blockId),text=block?.[raw?.language],numbers=raw?.numbers;
      if(!raw||!['body','methods','caption'].includes(block?.kind)||!['en','zh'].includes(raw.language)||!validRange(text,raw.start,raw.end)||typeof raw.exactText!=='string'||raw.exactText!==text.slice(raw.start,raw.end)||!evidence(raw.sourceEvidence)||!Array.isArray(numbers)||!numbers.length||numbers.some(n=>!positive(n)||!byNumber.has(n))||new Set(numbers).size!==numbers.length){reject('citation',index,'invalid-span-target-or-source-evidence');continue;}
      const citationId='reference:'+blockKey(raw.blockId,raw.language)+':'+raw.start+':'+raw.end;
      const citation=Object.freeze({citationId,blockId:raw.blockId,language:raw.language,start:raw.start,end:raw.end,exactText:raw.exactText,numbers:Object.freeze([...numbers]),targets:Object.freeze(numbers.map(number=>byNumber.get(number))),index});
      const key=blockKey(raw.blockId,raw.language);if(!byBlock.has(key))byBlock.set(key,[]);byBlock.get(key).push(citation);
    }
    for(const [key,candidates] of byBlock){
      const accepted=candidates.filter(citation=>{
        if(candidates.some(other=>other!==citation&&other.start<citation.end&&citation.start<other.end)){reject('citation',citation.index,'overlapping-approved-spans');return false;}
        return true;
      }).sort((a,b)=>a.start-b.start);
      for(const citation of accepted)byId.set(citation.citationId,citation);byBlock.set(key,Object.freeze(accepted));
    }
    const empty=Object.freeze([]);
    return {forBlock:(blockId,language)=>byBlock.get(blockKey(blockId,language))||empty,get:id=>byId.get(id),getTarget:number=>byNumber.get(number),diagnostics:Object.freeze(diagnostics)};
  }
  const clamp=(value,min,max)=>Math.max(min,Math.min(Math.max(min,max),value));
  function positionPopover(anchor,size,area){
    const gap=8,margin=8,left=area.left+margin,top=area.top+margin,right=area.left+area.width-margin,bottom=area.top+area.height-margin;
    const below=anchor.bottom+gap,above=anchor.top-gap-size.height,placement=below+size.height<=bottom?'below':above>=top?'above':bottom-anchor.bottom>=anchor.top-top?'below':'above';
    return {left:clamp(anchor.left,left,right-size.width),top:clamp(placement==='below'?below:above,top,bottom-size.height),placement};
  }
  function create({paper,root,toolbar=null,navigateTo,onError=error=>console.error(error)}={}){
    if(!root||typeof navigateTo!=='function')throw Error('参考文献交互缺少必要接口');
    const index=createIndex(paper),doc=root.ownerDocument,win=doc.defaultView,removers=[],pendingRestores=new Set();
    let source=null,opened=null,frame=0,destroyed=false,focusTimer=0;
    const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);removers.push(()=>target.removeEventListener(type,fn,options));};
    const popover=doc.createElement('div');popover.className='reference-popover';popover.hidden=true;popover.setAttribute('role','dialog');popover.setAttribute('aria-modal','false');
    let serial=1;while(doc.getElementById('reference-popover-'+serial))serial++;popover.id='reference-popover-'+serial;
    const header=doc.createElement('div');header.className='reference-popover-header';
    const title=doc.createElement('strong');title.id=popover.id+'-title';popover.setAttribute('aria-labelledby',title.id);
    const closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='reference-popover-close';closeButton.textContent='关闭';closeButton.setAttribute('aria-label','关闭参考文献选择');header.append(title,closeButton);
    const list=doc.createElement('div');list.className='reference-popover-list';popover.append(header,list);doc.body.append(popover);
    const links=()=>Array.from(list.querySelectorAll('[data-reference-target-number]'));
    function inline(target){const candidate=target?.closest?.('.reference-link');return candidate&&root.contains(candidate)&&index.get(candidate.dataset.referenceCitationId)?candidate:null;}
    function setExpanded(citation,value){if(!citation)return;for(const element of root.querySelectorAll('.reference-link'))if(element.dataset.referenceCitationId===citation.citationId&&element.hasAttribute('aria-expanded'))element.setAttribute('aria-expanded',String(value));}
    function close({restoreFocus=false}={}){
      const previous=source;setExpanded(opened,false);source=null;opened=null;popover.hidden=true;clearTimeout(focusTimer);focusTimer=0;
      if(frame){win.cancelAnimationFrame(frame);frame=0;}
      if(restoreFocus&&previous?.isConnected)previous.focus({preventScroll:true});
    }
    function area(){
      const v=win.visualViewport,r={left:v?.offsetLeft??0,top:v?.offsetTop??0,width:v?.width??win.innerWidth,height:v?.height??win.innerHeight},bottom=r.top+r.height;
      if(toolbar?.isConnected&&!toolbar.hidden){const t=toolbar.getBoundingClientRect(),s=win.getComputedStyle(toolbar);if(s.display!=='none'&&s.visibility!=='hidden'&&t.width>0&&t.height>0&&t.bottom>r.top&&t.top<bottom&&t.right>r.left&&t.left<r.left+r.width)r.top=Math.min(bottom,Math.max(r.top,t.bottom));}
      r.height=Math.max(0,bottom-r.top);return r;
    }
    function position(){
      frame=0;if(!opened||!source?.isConnected){close();return;}
      const a=area(),r=source.getBoundingClientRect();
      if(r.width<=0||r.height<=0||r.bottom<=a.top||r.top>=a.top+a.height||r.right<=a.left||r.left>=a.left+a.width||a.height<80){close();return;}
      popover.style.maxWidth=Math.max(0,a.width-16)+'px';popover.style.maxHeight=Math.max(0,Math.min(360,a.height-16))+'px';
      const size=popover.getBoundingClientRect();if(size.width>a.width-16||size.height>a.height-16){close();return;}
      const p=positionPopover(r,size,a);popover.style.left=p.left+'px';popover.style.top=p.top+'px';popover.dataset.placement=p.placement;
    }
    function queuePosition(){if(opened&&!frame)frame=win.requestAnimationFrame(position);}
    function navigate(target){
      close();try{navigateTo(target.blockId);}catch(error){onError(error);return;}
      win.requestAnimationFrame(()=>{
        if(destroyed)return;const destination=doc.getElementById(target.blockId);if(!destination?.isConnected)return;
        const old=destination.getAttribute('tabindex');if(old===null)destination.setAttribute('tabindex','-1');destination.focus({preventScroll:true});
        if(old===null)destination.addEventListener('blur',()=>destination.removeAttribute('tabindex'),{once:true});
      });
    }
    function open(trigger,citation){
      if(opened?.citationId===citation.citationId){close({restoreFocus:true});return;}
      close();source=Array.from(root.querySelectorAll('.reference-link')).find(element=>element.dataset.referenceCitationId===citation.citationId&&Number(element.dataset.fragmentStart)===citation.start)||trigger;opened=citation;title.textContent='选择参考文献 '+citation.exactText;list.replaceChildren();
      for(const target of citation.targets){
        const link=doc.createElement('a');link.href='#'+encodeURIComponent(target.blockId);link.dataset.referenceTargetNumber=String(target.number);link.setAttribute('aria-label','参考文献 '+target.number+'，'+target.text);
        const number=doc.createElement('strong');number.className='reference-popover-number';number.textContent='参考文献 '+target.number;
        const preview=doc.createElement('span');preview.className='reference-popover-preview';preview.textContent=target.text;link.append(number,preview);list.append(link);
      }
      setExpanded(citation,true);popover.hidden=false;position();if(!popover.hidden)links()[0]?.focus({preventScroll:true});
    }
    function activate(trigger){const citation=index.get(trigger.dataset.referenceCitationId);if(!citation)return;if(citation.targets.length===1)navigate(citation.targets[0]);else open(trigger,citation);}
    function hasSelection(){const selection=win.getSelection();return !!selection&&!selection.isCollapsed&&selection.rangeCount>0;}
    function wrapFragment(content,citation,start,end){
      const verified=index.get(citation?.citationId);if(!verified||!Number.isInteger(start)||!Number.isInteger(end)||start<verified.start||end>verified.end||end<=start||content.textContent!==verified.exactText.slice(start-verified.start,end-verified.start))return content;
      if(content.nodeType===1&&(content.matches('a,button,[role="button"]')||content.querySelector('a,button,[role="button"]')))return content;
      const single=verified.targets.length===1,link=doc.createElement(single?'a':'span');link.className='reference-link';link.dataset.referenceCitationId=verified.citationId;link.dataset.referenceNumbers=verified.numbers.join(',');link.dataset.citationStart=String(verified.start);link.dataset.citationEnd=String(verified.end);link.dataset.fragmentStart=String(start);link.dataset.fragmentEnd=String(end);link.tabIndex=start===verified.start?0:-1;
      const label=single?'查看参考文献 '+verified.numbers[0]:'选择参考文献 '+verified.numbers.join('、');link.setAttribute('aria-label',label);link.title=label;
      if(single){link.href='#'+encodeURIComponent(verified.targets[0].blockId);link.draggable=false;}else{link.setAttribute('role','button');link.setAttribute('aria-haspopup','dialog');link.setAttribute('aria-controls',popover.id);link.setAttribute('aria-expanded','false');}
      if(start!==verified.start)link.setAttribute('aria-hidden','true');link.append(content);return link;
    }
    listen(root,'click',event=>{
      const trigger=inline(event.target);if(!trigger)return;
      if(hasSelection()||event.target.closest?.('[data-annotation-id]')){event.preventDefault();return;}
      if(event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
      event.preventDefault();event.stopPropagation();activate(trigger);
    },true);
    listen(root,'keydown',event=>{
      const trigger=inline(event.target);if(!trigger||!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopPropagation();if(!hasSelection())activate(trigger);
    },true);
    // Focusable inline spans can interrupt Chromium text dragging. Defer their
    // pointer focus without cancelling pointerdown or changing the native range.
    listen(root,'pointerdown',event=>{
      const trigger=inline(event.target);if(!trigger||event.button!==0||trigger.tagName==='A')return;
      const old=trigger.getAttribute('tabindex');trigger.removeAttribute('tabindex');
      const restore=()=>{if(old===null)trigger.removeAttribute('tabindex');else trigger.setAttribute('tabindex',old);doc.removeEventListener('pointerup',restore);doc.removeEventListener('pointercancel',restore);win.removeEventListener('blur',restore);pendingRestores.delete(restore);};
      pendingRestores.add(restore);doc.addEventListener('pointerup',restore);doc.addEventListener('pointercancel',restore);win.addEventListener('blur',restore);
    });
    listen(closeButton,'click',()=>close({restoreFocus:true}));
    listen(list,'click',event=>{const link=event.target.closest?.('[data-reference-target-number]');if(!link||!list.contains(link)||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;const target=index.getTarget(Number(link.dataset.referenceTargetNumber));if(target){event.preventDefault();navigate(target);}});
    listen(popover,'keydown',event=>{
      const targets=links(),current=targets.indexOf(doc.activeElement);let next;
      if(event.key==='ArrowDown')next=current<0?0:(current+1)%targets.length;else if(event.key==='ArrowUp')next=current<0?targets.length-1:(current+targets.length-1)%targets.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=targets.length-1;
      if(next!==undefined&&targets.length){event.preventDefault();event.stopPropagation();targets[next].focus({preventScroll:true});}
    });
    listen(doc,'keydown',event=>{if(opened&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close({restoreFocus:true});}});
    listen(doc,'pointerdown',event=>{if(opened&&!popover.contains(event.target)&&inline(event.target)?.dataset.referenceCitationId!==opened.citationId)close();},true);
    listen(popover,'focusout',()=>{clearTimeout(focusTimer);focusTimer=win.setTimeout(()=>{if(opened&&!popover.contains(doc.activeElement))close();},0);});
    listen(doc,'scroll',queuePosition,{capture:true,passive:true});listen(win,'resize',queuePosition,{passive:true});listen(win,'blur',()=>close());
    if(win.visualViewport){listen(win.visualViewport,'resize',queuePosition,{passive:true});listen(win.visualViewport,'scroll',queuePosition,{passive:true});}
    return {forBlock:index.forBlock,wrapFragment,close,isOpen:()=>!!opened,diagnostics:index.diagnostics,destroy(){if(destroyed)return;close();destroyed=true;pendingRestores.forEach(restore=>restore());removers.forEach(remove=>remove());popover.remove();}};
  }
  return {createIndex,validRange,positionPopover,create};
});
