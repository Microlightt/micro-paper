(function(global,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(global)global.MicroPaperSelectionTools=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const COLORS=Object.freeze(['yellow','green','blue','pink','orange']);
  const LABELS=Object.freeze({yellow:'浅黄色',green:'浅绿色',blue:'浅蓝色',pink:'浅粉色',orange:'浅橘色'});
  const anchorKeys=['blockId','language','start','end','quote'];
  const sameAnchor=(a,b)=>!!a&&!!b&&anchorKeys.every(key=>a[key]===b[key]);
  const clamp=(value,min,max)=>Math.min(Math.max(value,min),Math.max(min,max));

  // All coordinates are CSS pixels in the layout viewport. visualViewport's
  // offsets keep a fixed toolbar inside the visible area during pinch zoom.
  function calculatePosition({rect,toolbar,viewport,margin=8,gap=9}){
    const left=viewport.left+margin,top=viewport.top+margin;
    const right=viewport.left+viewport.width-margin,bottom=viewport.top+viewport.height-margin;
    const above=rect.top-gap-toolbar.height,below=rect.bottom+gap;
    const placement=above>=top?'above':below+toolbar.height<=bottom?'below':rect.top-top>=bottom-rect.bottom?'above':'below';
    return {left:clamp((rect.left+rect.right-toolbar.width)/2,left,right-toolbar.width),top:clamp(placement==='above'?above:below,top,bottom-toolbar.height),placement};
  }

  function create({element,reader,toolbar=null,readSelection,onHighlight,onNote,isEnabled=()=>true,onError=error=>console.error(error)}={}){
    if(!element||!reader||typeof readSelection!=='function'||typeof onHighlight!=='function'||typeof onNote!=='function')throw Error('选区工具缺少必要接口');
    const doc=element.ownerDocument,win=doc.defaultView,removers=[];
    let current=null,timer=0,frame=0,pointerInside=false,busy=false,destroyed=false;
    const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);removers.push(()=>target.removeEventListener(type,handler,options));};
    const buttons=[];
    element.replaceChildren();element.hidden=true;element.setAttribute('role','toolbar');element.setAttribute('aria-label','选区高亮与笔记');element.setAttribute('aria-keyshortcuts','Shift+F10');
    for(const color of COLORS){
      const button=doc.createElement('button');button.type='button';button.className='selection-color';button.dataset.highlightColor=color;button.setAttribute('aria-label',LABELS[color]+'高亮');button.title=LABELS[color]+'高亮';
      const swatch=doc.createElement('span');swatch.className='selection-swatch';swatch.setAttribute('aria-hidden','true');button.append(swatch);element.append(button);buttons.push(button);
    }
    const note=doc.createElement('button');note.type='button';note.id='selection-note';note.textContent='添加笔记';note.setAttribute('aria-label','为所选文字添加笔记');element.append(note);buttons.push(note);
    buttons.forEach((button,index)=>button.tabIndex=index===0?0:-1);
    const inToolbar=target=>!!target&&element.contains(target);
    const connected=range=>!!range&&range.startContainer.isConnected&&range.endContainer.isConnected&&reader.contains(range.startContainer)&&reader.contains(range.endContainer);
    function read(range){
      if(!connected(range)||range.collapsed)return null;
      try{const value=readSelection(range);return value&&typeof value.quote==='string'&&value.quote.trim()?{...value}:null;}catch(error){return null;}
    }
    function viewport(){
      const v=win.visualViewport,area={left:v?.offsetLeft??0,top:v?.offsetTop??0,width:v?.width??win.innerWidth,height:v?.height??win.innerHeight},bottom=area.top+area.height;
      if(toolbar?.isConnected&&!toolbar.hidden){
        const rect=toolbar.getBoundingClientRect(),style=win.getComputedStyle(toolbar);
        if(style.display!=='none'&&!['hidden','collapse'].includes(style.visibility)&&rect.width>0&&rect.height>0&&rect.right>area.left&&rect.left<area.left+area.width&&rect.bottom>area.top&&rect.top<bottom)area.top=Math.min(bottom,Math.max(area.top,rect.bottom));
      }
      area.height=Math.max(0,bottom-area.top);return area;
    }
    function surfaceFits(area,rect=element.getBoundingClientRect()){
      return rect.width+16<=area.width+.5&&rect.height+16<=area.height+.5&&!(element.scrollWidth>element.clientWidth+1);
    }
    function hide(){
      clearTimeout(timer);timer=0;current=null;pointerInside=false;element.hidden=true;element.style.visibility='';
      if(frame){win.cancelAnimationFrame(frame);frame=0;}
    }
    function focusAllowed(){const active=doc.activeElement;return !active||inToolbar(active)||!active.matches?.('input,textarea,select,[contenteditable="true"]');}
    function clippingBounds(range,v){
      const bounds={left:v.left,top:v.top,right:v.left+v.width,bottom:v.top+v.height};
      let ancestor=range.commonAncestorContainer||range.startContainer;
      if(ancestor.nodeType===3)ancestor=ancestor.parentElement;
      // Only shared ancestors clip the whole selection; individual inline
      // descendants need not constrain the other fragments in the same prose.
      while(ancestor&&!ancestor.contains(range.endContainer))ancestor=ancestor.parentElement;
      for(;ancestor;ancestor=ancestor.parentElement){
        const style=win.getComputedStyle(ancestor),clipsX=/^(auto|scroll|hidden|clip)$/.test(style.overflowX),clipsY=/^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if(!clipsX&&!clipsY)continue;
        const r=ancestor.getBoundingClientRect(),scaleX=ancestor.offsetWidth>0?r.width/ancestor.offsetWidth:1,scaleY=ancestor.offsetHeight>0?r.height/ancestor.offsetHeight:1;
        // client bounds exclude borders and scrollbar gutters. Scaling retains
        // this conservative padding-box clip when an ancestor is transformed.
        const left=r.left+ancestor.clientLeft*scaleX,top=r.top+ancestor.clientTop*scaleY;
        if(clipsX){bounds.left=Math.max(bounds.left,left);bounds.right=Math.min(bounds.right,left+ancestor.clientWidth*scaleX);}
        if(clipsY){bounds.top=Math.max(bounds.top,top);bounds.bottom=Math.min(bounds.bottom,top+ancestor.clientHeight*scaleY);}
      }
      return bounds;
    }
    function visibleRect(){
      if(!current)return null;
      const bounds=clippingBounds(current.range,viewport()),rects=Array.from(current.range.getClientRects()).map(r=>{
        const left=Math.max(r.left,bounds.left),right=Math.min(r.right,bounds.right),top=Math.max(r.top,bounds.top),bottom=Math.min(r.bottom,bounds.bottom);
        return {left,right,top,bottom,width:right-left,height:bottom-top};
      }).filter(r=>r.width>0&&r.height>0);
      if(!rects.length)return null;
      return current.backwards?rects[0]:rects[rects.length-1];
    }
    function position(){
      frame=0;if(!current||element.hidden)return;
      if(!isEnabled()||!sameAnchor(current.annotation,read(current.range))){hide();return;}
      const rect=visibleRect();if(!rect){hide();return;}
      const v=viewport();element.style.maxWidth=Math.max(0,v.width-16)+'px';
      const surface=element.getBoundingClientRect();if(!surfaceFits(v,surface)){hide();return;}
      const result=calculatePosition({rect,toolbar:surface,viewport:v});
      element.style.left=result.left+'px';element.style.top=result.top+'px';element.dataset.placement=result.placement;element.style.visibility='';
    }
    function queuePosition(){if(!frame&&!element.hidden)frame=win.requestAnimationFrame(position);}
    function capture(selection){
      if(!selection||selection.isCollapsed||selection.rangeCount!==1)return null;
      const range=selection.getRangeAt(0).cloneRange(),annotation=read(range);if(!annotation)return null;
      return {range,annotation,backwards:selection.focusNode===range.startContainer&&selection.focusOffset===range.startOffset};
    }
    function refresh(){
      clearTimeout(timer);timer=0;if(destroyed||busy)return;
      if(!isEnabled()||!focusAllowed()){hide();return;}
      const selection=win.getSelection(),next=capture(selection);
      if(next)current=next;
      else if(!current||!(pointerInside||inToolbar(doc.activeElement))||!sameAnchor(current.annotation,read(current.range))){hide();return;}
      // The toolbar never focuses itself on selection: native touch handles and
      // keyboard selection remain owned by the document until an explicit action.
      element.style.visibility='hidden';element.hidden=false;position();
    }
    function queueRefresh(delay=55){clearTimeout(timer);timer=win.setTimeout(refresh,delay);}
    function validatedAction(){
      if(destroyed||busy||element.hidden||!current||!isEnabled())return null;
      // A live Range can silently move when its text/DOM is replaced. Verify
      // the originally shown anchor before considering a newer native range.
      if(!sameAnchor(current.annotation,read(current.range))||!visibleRect()||!surfaceFits(viewport())){hide();return null;}
      const selection=win.getSelection();
      if(selection&&!selection.isCollapsed){
        const next=capture(selection);if(!next){hide();return null;}current=next;
      }else if(!pointerInside&&!inToolbar(doc.activeElement)){hide();return null;}
      const verified=read(current.range);if(!sameAnchor(current.annotation,verified)||!visibleRect()){hide();return null;}
      return {...current.annotation,color:COLORS.includes(current.annotation.color)?current.annotation.color:'yellow'};
    }
    async function invoke(button){
      const annotation=validatedAction();if(!annotation)return;
      const color=button.dataset.highlightColor;busy=true;hide();
      try{if(color)await onHighlight({...annotation,color},color);else await onNote(annotation);}
      catch(error){onError(error);}finally{busy=false;}
    }
    listen(element,'pointerdown',event=>{
      if(event.button!==0)return;
      // Preventing focus on mouse AND touch leaves the native range intact.
      // A clone is kept for keyboard focus and browsers which collapse it anyway.
      pointerInside=true;event.preventDefault();
    });
    listen(element,'click',event=>{const button=event.target.closest?.('button');if(button&&element.contains(button)){event.preventDefault();invoke(button);}});
    listen(element,'focusin',event=>{if(buttons.includes(event.target))buttons.forEach(button=>button.tabIndex=button===event.target?0:-1);});
    listen(element,'keydown',event=>{
      const index=buttons.indexOf(doc.activeElement);if(index<0)return;
      let next;if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;
      if(next!==undefined){event.preventDefault();buttons[next].focus({preventScroll:true});}
    });
    listen(doc,'pointerdown',event=>{if(!inToolbar(event.target))hide();},true);
    listen(doc,'pointerup',()=>{if(pointerInside)win.setTimeout(()=>{pointerInside=false;},0);else queueRefresh(20);},{passive:true});
    listen(doc,'pointercancel',()=>{pointerInside=false;queueRefresh();},{passive:true});
    listen(doc,'touchend',event=>{if(!inToolbar(event.target))queueRefresh(100);},{passive:true});
    listen(doc,'selectionchange',()=>queueRefresh());
    listen(doc,'keyup',event=>{if(event.key==='Shift'||event.key.startsWith('Arrow'))queueRefresh(0);});
    listen(doc,'keydown',event=>{
      if(event.key==='Escape'&&!element.hidden){event.preventDefault();hide();}
      else if(event.key==='F10'&&event.shiftKey){refresh();if(!element.hidden){event.preventDefault();buttons.find(button=>button.tabIndex===0).focus({preventScroll:true});}}
    });
    listen(doc,'focusin',event=>{if(!inToolbar(event.target)&&!reader.contains(event.target))hide();});
    listen(doc,'scroll',queuePosition,{capture:true,passive:true});listen(win,'resize',queuePosition,{passive:true});listen(win,'blur',hide);
    if(win.visualViewport){listen(win.visualViewport,'resize',queuePosition,{passive:true});listen(win.visualViewport,'scroll',queuePosition,{passive:true});}
    return {refresh,hide,destroy(){if(destroyed)return;hide();destroyed=true;removers.forEach(remove=>remove());}};
  }
  return {COLORS,calculatePosition,create};
});
