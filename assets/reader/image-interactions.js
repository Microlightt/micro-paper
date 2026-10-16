/* Figure and modal zoom use a complete, undistorted contain-fit base. */
(()=>{'use strict';
const MIN_SCALE=.5,MAX_SCALE=8,PADDING=8;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const cleanScale=value=>Number.isFinite(Number(value))?clamp(Number(value),MIN_SCALE,MAX_SCALE):1;
const $=selector=>document.querySelector(selector);

window.createImageInteractions=function createImageInteractions(options={}){
 const dialog=$('#image-dialog'),zoomViewport=$('#image-scroll'),zoomImage=$('#zoom-image');
 const tools=$('#image-tools')||$('.image-tools'),initialInput=$('#figure-initial-scale');
 const views=new Map(),cleanup=[];
 let figureView=null,zoomView=null,locked=null,destroyed=false;
 const listen=(target,type,handler,settings)=>{if(!target)return;target.addEventListener(type,handler,settings);cleanup.push(()=>target.removeEventListener(type,handler,settings))};

 function createView(viewport,img,{modal=false,initial=1,saved,onChange}={}){
  const abort=new AbortController(),signal=abort.signal;
  let baseScale=0,width=0,height=0,relative=cleanScale(saved?.relative??initial),x=0,y=0,drag=null,suppressClickUntil=0;
  let center=saved?{x:saved.centerX,y:saved.centerY}:null;
  Object.assign(viewport.style,{position:'relative',overflow:'hidden',overscrollBehavior:'auto'});
  Object.assign(img.style,{position:'absolute',left:'0px',top:'0px',width:'auto',height:'auto',maxWidth:'none',maxHeight:'none',margin:'0',transformOrigin:'0 0',userSelect:'none'});
  img.draggable=false;
  if(!viewport.hasAttribute('tabindex'))viewport.tabIndex=0;
  const point=e=>{const r=viewport.getBoundingClientRect();return{x:e.clientX-r.left-viewport.clientLeft,y:e.clientY-r.top-viewport.clientTop}};
  const overImage=e=>{
   if(e.target!==img||!baseScale)return false;
   const r=img.getBoundingClientRect(),v=viewport.getBoundingClientRect(),left=v.left+viewport.clientLeft,top=v.top+viewport.clientTop;
   return e.clientX>=Math.max(r.left,left)&&e.clientX<Math.min(r.right,left+viewport.clientWidth)&&e.clientY>=Math.max(r.top,top)&&e.clientY<Math.min(r.bottom,top+viewport.clientHeight);
  };
  const currentScale=()=>baseScale*relative;
  const snapshot=()=>({relative,pixelScale:currentScale(),scaleBasis:'contain-fit',centerX:baseScale?(width/2-x)/currentScale()/img.naturalWidth:.5,centerY:baseScale?(height/2-y)/currentScale()/img.naturalHeight:.5});
  function constrain(){
   const w=img.naturalWidth*currentScale(),h=img.naturalHeight*currentScale();
   x=w<=width?clamp(x,0,width-w):clamp(x,width-w,0);
   y=h<=height?clamp(y,0,height-h):clamp(y,height-h,0);
  }
  function render(){
   viewport.classList.toggle('is-interactive',true);
   // Touch and wheel over letterbox space keep normal reading behavior. Only
   // a gesture that starts on the image is reserved for local pan and zoom.
   viewport.style.touchAction=modal?'none':'auto';viewport.style.overscrollBehavior=modal?'contain':'auto';
   img.style.touchAction='none';img.style.cursor=drag?'grabbing':'grab';
   viewport.dataset.imageScale=img.dataset.imageScale=String(relative);
   viewport.dataset.imagePixelScale=img.dataset.imagePixelScale=String(currentScale());
   viewport.dataset.imageScaleBasis=img.dataset.imageScaleBasis='contain-fit';
   if(!baseScale){onChange?.(snapshot());return}
   constrain();img.style.width=img.naturalWidth+'px';img.style.height=img.naturalHeight+'px';
   img.style.transform=`translate(${x}px,${y}px) scale(${currentScale()})`;
   viewport.dataset.imagePanX=String(x);viewport.dataset.imagePanY=String(y);
   onChange?.(snapshot());
  }
  function refresh(){
   const w=viewport.clientWidth,h=viewport.clientHeight;if(!img.naturalWidth||!img.naturalHeight||w<=0||h<=0)return false;
   const nextCenter=center||(baseScale?snapshot():{centerX:.5,centerY:.5});
   width=w;height=h;
   // The reader owns frame dimensions. Fill its available width or height while
   // retaining the whole image; only the modal reserves an outside-click margin.
   const padding=modal?PADDING:0;
   baseScale=Math.min(Math.max(1,w-padding*2)/img.naturalWidth,Math.max(1,h-padding*2)/img.naturalHeight);
   x=w/2-(nextCenter.centerX??nextCenter.x??.5)*img.naturalWidth*currentScale();
   y=h/2-(nextCenter.centerY??nextCenter.y??.5)*img.naturalHeight*currentScale();center=null;render();return true;
  }
  function zoomAt(factor,p={x:width/2,y:height/2}){
   if(!baseScale){refresh();if(!baseScale)return}
   const before=currentScale(),imageX=(p.x-x)/before,imageY=(p.y-y)/before;
   relative=clamp(relative*factor,MIN_SCALE,MAX_SCALE);
   x=p.x-imageX*currentScale();y=p.y-imageY*currentScale();render();
  }
  function reset(scale=1){relative=cleanScale(scale);center={x:.5,y:.5};if(!refresh())render()}
  function endDrag(e){
   if(!drag||e.pointerId!==drag.id)return;
   // Pointer capture can retarget even an unmoved image click to its viewport.
   // Consume this gesture's click so it cannot be mistaken for blank space.
   suppressClickUntil=performance.now()+650;
   const id=drag.id;drag=null;if(viewport.hasPointerCapture?.(id))viewport.releasePointerCapture(id);render();
  }
  viewport.addEventListener('pointerdown',e=>{
   suppressClickUntil=0;
   if(e.button!==0||e.isPrimary===false||!overImage(e))return;
   e.preventDefault();viewport.focus({preventScroll:true});drag={id:e.pointerId,start:point(e),x,y,moved:false};
   viewport.setPointerCapture?.(e.pointerId);render();
  },{signal});
  viewport.addEventListener('pointermove',e=>{
   if(!drag||e.pointerId!==drag.id)return;
   const p=point(e),dx=p.x-drag.start.x,dy=p.y-drag.start.y;
   if(Math.hypot(dx,dy)>4)drag.moved=true;
   x=drag.x+dx;y=drag.y+dy;render();e.preventDefault();
  },{signal});
  viewport.addEventListener('pointerup',endDrag,{signal});
  viewport.addEventListener('pointercancel',e=>{if(drag)drag.moved=true;endDrag(e)},{signal});
  viewport.addEventListener('lostpointercapture',e=>{if(drag?.id===e.pointerId){suppressClickUntil=performance.now()+650;drag=null;render()}},{signal});
  viewport.addEventListener('click',e=>{
   if(performance.now()<suppressClickUntil){suppressClickUntil=0;e.preventDefault();e.stopImmediatePropagation();return}
  },{signal,capture:true});
  viewport.addEventListener('wheel',e=>{
   if(!overImage(e))return;
   e.preventDefault();e.stopPropagation();
   const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?height:1);
   if(pixels)zoomAt(Math.exp(clamp(-pixels*.002,-Math.log(2),Math.log(2))),point(e));
  },{signal,passive:false});
  viewport.addEventListener('keydown',e=>{
   if(e.target!==viewport)return;
   if(e.key==='+'||e.key==='='){e.preventDefault();zoomAt(1.25)}
   else if(e.key==='-'){e.preventDefault();zoomAt(1/1.25)}
   else if(e.key==='0'){e.preventDefault();reset()}
   else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();if(e.key==='ArrowLeft')x+=40;if(e.key==='ArrowRight')x-=40;if(e.key==='ArrowUp')y+=40;if(e.key==='ArrowDown')y-=40;render();
   }
  },{signal});
  img.addEventListener('load',refresh,{signal});
  const observer=new ResizeObserver(refresh);observer.observe(viewport);render();refresh();
  return{viewport,img,zoomAt,reset,refresh,snapshot,render,
   suppressClick:()=>performance.now()<suppressClickUntil,
   clearClickSuppression:()=>{suppressClickUntil=0},
   destroy(){const state=snapshot();abort.abort();observer.disconnect();return state}};
 }

 function updateOutput(state){
  const output=$('#figure-scale-output');if(output){output.textContent=Math.round(state.relative*100)+'%';output.value=Math.round(state.relative*100)+'%'}
  if(initialInput)initialInput.value=String(Math.round(state.relative*1000)/1000);
 }
 function mountFigure(viewport,img,id){
  const sameFigure=figureView?.id===id;
  if(figureView){views.set(figureView.id,figureView.destroy());figureView=null}
  // A new selection starts with the whole figure, including when revisiting a
  // previously zoomed figure. Rerendering the current figure preserves its view.
  const view=createView(viewport,img,{initial:1,saved:sameFigure?views.get(id):undefined,onChange:state=>{views.set(id,state);updateOutput(state)}});
  view.id=id;figureView=view;return view;
 }
 function lockScroll(){
  if(locked)return;const style=document.body.style,props=['position','top','left','width','overflow'];
  locked={x:window.scrollX,y:window.scrollY,focus:document.activeElement,styles:props.map(name=>[name,style.getPropertyValue(name),style.getPropertyPriority(name)])};
  style.setProperty('position','fixed');style.setProperty('top',-locked.y+'px');style.setProperty('left',-locked.x+'px');style.setProperty('width','100%');style.setProperty('overflow','hidden');
 }
 function unlockScroll(){
  if(!locked)return;const previous=locked;locked=null;
  for(const [name,value,priority]of previous.styles){if(value)document.body.style.setProperty(name,value,priority);else document.body.style.removeProperty(name)}
  const restore=()=>{window.scrollTo(previous.x,previous.y);if(previous.focus?.isConnected)previous.focus.focus?.({preventScroll:true})};restore();requestAnimationFrame(()=>{if(!locked)restore()});
 }
 function closeZoom(){if(dialog?.open)dialog.close();else unlockScroll()}
 function openZoom(asset){
  if(destroyed||!dialog||!zoomViewport||!zoomImage||!asset)return;
  zoomView?.destroy();zoomView=null;lockScroll();zoomImage.src=asset;
  try{if(!dialog.open)dialog.showModal()}catch(error){unlockScroll();throw error}
  zoomView=createView(zoomViewport,zoomImage,{modal:true,initial:1});zoomView.reset(1);
 }
 function fitZoom(){zoomView?.reset(1)}
 function fitFigure(){figureView?.reset(1)}
 function zoomBy(factor){if(Number.isFinite(factor)&&factor>0)zoomView?.zoomAt(factor)}
 listen(dialog,'close',()=>{zoomView?.destroy();zoomView=null;unlockScroll()});
 listen(dialog,'cancel',e=>{e.preventDefault();closeZoom()});
 // A fresh pointer gesture on blank space must close, including immediately
 // after an image gesture whose browser-generated click was already consumed.
 listen(dialog,'pointerdown',()=>zoomView?.clearClickSuppression(),{capture:true});
 listen(dialog,'click',e=>{
  if(zoomView?.suppressClick()){zoomView.clearClickSuppression();e.preventDefault();return}
  if(e.target===zoomImage||zoomImage?.contains(e.target)||tools?.contains(e.target))return;
  closeZoom();
 });
 // Wheel over the modal's blank edges or tools must not escape into the article.
 listen(dialog,'wheel',e=>{e.preventDefault()},{passive:false});
 listen($('#zoom-in'),'click',()=>zoomBy(1.25));listen($('#zoom-out'),'click',()=>zoomBy(1/1.25));listen($('#zoom-fit'),'click',fitZoom);
 listen($('#figure-zoom-in'),'click',()=>figureView?.zoomAt(1.25));listen($('#figure-zoom-out'),'click',()=>figureView?.zoomAt(1/1.25));listen($('#figure-fit'),'click',fitFigure);
 if(initialInput){initialInput.min=String(MIN_SCALE);initialInput.max=String(MAX_SCALE);initialInput.step='0.1';initialInput.value='1'}
 listen(initialInput,'change',()=>{
  if(!initialInput.value.trim()||!Number.isFinite(Number(initialInput.value))){initialInput.value=String(Math.round((figureView?.snapshot().relative??1)*1000)/1000);return}
  const scale=cleanScale(initialInput.value);initialInput.value=String(scale);
  views.clear();figureView?.reset(scale);
 });
 listen(document,'keydown',e=>{
  if(!dialog?.open||e.target?.matches('input,textarea,select'))return;
  if(e.key==='Escape'){e.preventDefault();closeZoom()}
  else if(e.target!==zoomViewport&&(e.key==='+'||e.key==='=')){e.preventDefault();zoomBy(1.25)}
  else if(e.target!==zoomViewport&&e.key==='-'){e.preventDefault();zoomBy(1/1.25)}
  else if(e.target!==zoomViewport&&e.key==='0'){e.preventDefault();fitZoom()}
  else if(['PageDown','PageUp','Home','End',' '].includes(e.key))e.preventDefault();
 });
 return{mountFigure,openZoom,fitFigure,fitZoom,zoomBy,closeZoom,
  refresh(){figureView?.refresh();zoomView?.refresh()},
  destroy(){destroyed=true;closeZoom();unlockScroll();figureView?.destroy();zoomView?.destroy();for(const stop of cleanup)stop();views.clear()}};
};
})();
