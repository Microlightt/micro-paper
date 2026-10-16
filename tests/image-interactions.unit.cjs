/* Controller regression using a small DOM/event stub. This is not browser evidence. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
class Style{
 constructor(){this.values=new Map()}
 setProperty(name,value,priority=''){this.values.set(name,[String(value),priority])}
 getPropertyValue(name){return this.values.get(name)?.[0]||''}
 getPropertyPriority(name){return this.values.get(name)?.[1]||''}
 removeProperty(name){this.values.delete(name)}
}
class Element{
 constructor({width=400,height=600,naturalWidth=0,naturalHeight=0,left=0,top=0}={}){
  this.style=new Style();this.dataset={};this.listeners=new Map();this.attributes=new Map();this.clientWidth=width;this.clientHeight=height;this.clientLeft=this.clientTop=0;this.naturalWidth=naturalWidth;this.naturalHeight=naturalHeight;this.rectLeft=left;this.rectTop=top;this.checked=false;this.value='';this.isConnected=true;this.captures=new Set();this.classList={toggle(){}};
 }
 addEventListener(type,handler,options={}){const list=this.listeners.get(type)||[];list.push(handler);this.listeners.set(type,list);options.signal?.addEventListener('abort',()=>this.removeEventListener(type,handler),{once:true})}
 removeEventListener(type,handler){this.listeners.set(type,(this.listeners.get(type)||[]).filter(h=>h!==handler))}
 emit(type,data={}){const event={type,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){},stopImmediatePropagation(){this.stopped=true},...data};for(const h of [...this.listeners.get(type)||[]]){h(event);if(event.stopped)break}return event}
 hasAttribute(name){return this.attributes.has(name)}
 getBoundingClientRect(){
  const transform=this.style.transform?.match(/translate\(([-.\deE+]+)px,([-.\deE+]+)px\) scale\(([-.\deE+]+)\)/);
  let left=this.rectLeft,top=this.rectTop,width=this.clientWidth,height=this.clientHeight;
  if(transform){const parent=this.container?.getBoundingClientRect()||{left:0,top:0};left=parent.left+(this.container?.clientLeft||0)+Number(transform[1]);top=parent.top+(this.container?.clientTop||0)+Number(transform[2]);width=this.naturalWidth*Number(transform[3]);height=this.naturalHeight*Number(transform[3])}
  return{left,top,width,height,right:left+width,bottom:top+height};
 }
 setPointerCapture(id){this.captures.add(id)}
 hasPointerCapture(id){return this.captures.has(id)}
 releasePointerCapture(id){this.captures.delete(id)}
 contains(other){return other===this}
 focus(){document.activeElement=this}
 matches(){return false}
 showModal(){this.open=true}
 close(){this.open=false;this.emit('close')}
}
const nodes=new Map();
for(const id of ['image-dialog','image-scroll','zoom-image','image-tools','zoom-in','zoom-out','zoom-fit','figure-initial-scale','figure-zoom-in','figure-zoom-out','figure-fit','figure-scale-output'])nodes.set('#'+id,new Element());
nodes.get('#zoom-image').naturalWidth=nodes.get('#zoom-image').naturalHeight=1000;
nodes.get('#zoom-image').container=nodes.get('#image-scroll');
const body=new Element(),document=new Element();document.body=body;document.activeElement=new Element();document.querySelector=selector=>nodes.get(selector)||null;
const window={scrollX:13,scrollY:728,scrollTo(x,y){this.scrollX=x;this.scrollY=y}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/reader/image-interactions.js'),'utf8'),{window,document,AbortController,performance,requestAnimationFrame:fn=>fn(),ResizeObserver:class{observe(){}disconnect(){}}});
let preference=7;const images=window.createImageInteractions({getInitialScale:()=>preference,onInitialScaleChange:scale=>{preference=scale}});
const mount=(viewport,img,id)=>{img.container=viewport;return images.mountFigure(viewport,img,id)};
const near=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-8,message||('Expected '+a+' = '+b));
const actualScale=image=>{const r=image.getBoundingClientRect(),scale=r.width/image.naturalWidth;near(r.height/image.naturalHeight,scale,'Image was stretched');return scale};
const assertScale=(view,image,relative,base)=>{near(Number(view.dataset.imageScale),relative);near(actualScale(image),base*relative);near(Number(view.dataset.imagePixelScale),base*relative);near(Number(image.dataset.imagePixelScale),base*relative);assert.equal(view.dataset.imageScaleBasis,'contain-fit')};
const pixels=(view,image,p)=>{const scale=actualScale(image);return{x:(p.x-Number(view.dataset.imagePanX))/scale,y:(p.y-Number(view.dataset.imagePanY))/scale}};
function fullFit(view,image,padding=0){const r=image.getBoundingClientRect(),v=view.getBoundingClientRect();near(actualScale(image),Math.min((view.clientWidth-2*padding)/image.naturalWidth,(view.clientHeight-2*padding)/image.naturalHeight));assert.ok(r.left>=v.left+padding-1e-8&&r.right<=v.right-padding+1e-8&&r.top>=v.top+padding-1e-8&&r.bottom<=v.bottom-padding+1e-8,'Fit clipped image');assert.ok(Math.abs(r.width-(view.clientWidth-2*padding))<1e-8||Math.abs(r.height-(view.clientHeight-2*padding))<1e-8,'Fit did not maximize available width or height');}
const large={naturalWidth:1200,naturalHeight:800},viewport=new Element(),img=new Element(large);img.src='test-figure';
let mounted=mount(viewport,img,'main:1');const base=1/3;
assertScale(viewport,img,1,base);fullFit(viewport,img);assert.equal(nodes.get('#figure-scale-output').textContent,'100%');near(Number(viewport.dataset.imagePanX),0);near(Number(viewport.dataset.imagePanY),(600-800*base)/2);assert.equal(viewport.style.aspectRatio,undefined);
console.log('PASS ordinary figure opens at maximum complete contain fit, centered and undistorted, ignoring stale initial source-pixel preference');
const point={x:viewport.clientWidth*.7,y:viewport.clientHeight*.7},before=pixels(viewport,img,point);
const zoomEvent=viewport.emit('wheel',{target:img,clientX:point.x,clientY:point.y,deltaY:-Math.log(1.1)/.002,deltaMode:0});assert.equal(zoomEvent.defaultPrevented,true);assertScale(viewport,img,1.1,base);const after=pixels(viewport,img,point);near(before.x,after.x);near(before.y,after.y);
console.log('PASS direct inline wheel preserves source coordinates under an off-center pointer with fit-relative zoom');
const smallView=new Element(),smallImage=new Element({naturalWidth:200,naturalHeight:100});mount(smallView,smallImage,'main:small');assertScale(smallView,smallImage,1,2);fullFit(smallView,smallImage);assert.equal(smallView.style.aspectRatio,undefined);assert.equal(smallView.style.overscrollBehavior,'auto');assert.equal(smallView.style.touchAction,'auto');assert.equal(smallImage.style.touchAction,'none');
const blank=smallView.emit('wheel',{target:smallView,clientX:200,clientY:20,deltaY:120,deltaMode:0}),outsideBounds=smallView.emit('wheel',{target:smallImage,clientX:200,clientY:20,deltaY:120,deltaMode:0});assert.equal(blank.defaultPrevented,false);assert.equal(outsideBounds.defaultPrevented,false);assertScale(smallView,smallImage,1,2);
const control=new Element(),caption=new Element(),controlWheel=smallView.emit('wheel',{target:control,clientX:200,clientY:300,deltaY:120,deltaMode:0}),captionWheel=caption.emit('wheel',{clientX:200,clientY:300,deltaY:120,deltaMode:0});assert.equal(controlWheel.defaultPrevented,false);assert.equal(captionWheel.defaultPrevented,false);assert.equal(caption.style.touchAction,undefined);assert.equal(caption.style.userSelect,undefined);
console.log('PASS small original maximizes contain fit while letterbox, controls and caption preserve ordinary reading scroll (DOM stub)');
mounted=mount(viewport,img,'main:1');assertScale(viewport,img,1,base);mounted.zoomAt(1e8);assertScale(viewport,img,8,base);mounted.zoomAt(1e-8);assertScale(viewport,img,.5,base);nodes.get('#figure-fit').emit('click');assertScale(viewport,img,1,base);fullFit(viewport,img);assert.equal(nodes.get('#figure-scale-output').textContent,'100%');
console.log('PASS switching back resets to fit, .5–8 fit-relative bounds clamp and reset maximizes complete image');
const blankDown=viewport.emit('pointerdown',{target:viewport,button:0,isPrimary:true,pointerId:9,pointerType:'touch',clientX:200,clientY:20});assert.equal(blankDown.defaultPrevented,false);assert.equal(viewport.hasPointerCapture(9),false);
mounted.zoomAt(2);const panBefore=Number(viewport.dataset.imagePanX),touchDown=viewport.emit('pointerdown',{target:img,button:0,isPrimary:true,pointerId:1,pointerType:'touch',clientX:200,clientY:300});assert.equal(touchDown.defaultPrevented,true);assert.equal(viewport.hasPointerCapture(1),true);viewport.emit('pointermove',{pointerId:1,pointerType:'touch',clientX:220,clientY:320});viewport.emit('pointerup',{pointerId:1,pointerType:'touch',clientX:220,clientY:320});assert.notEqual(Number(viewport.dataset.imagePanX),panBefore);assertScale(viewport,img,2,base);assert.equal(viewport.emit('click',{target:viewport}).defaultPrevented,true);
console.log('PASS zoomed figure retains one-finger drag and prevents drag-ending click leak (DOM stub)');
const oldCenter=pixels(viewport,img,{x:200,y:300});mounted=mount(new Element(),new Element(large),'main:1');assertScale(mounted.viewport,mounted.img,2,base);const preserved=pixels(mounted.viewport,mounted.img,{x:200,y:300});near(preserved.x,oldCenter.x);near(preserved.y,oldCenter.y);
console.log('PASS same-figure rerender preserves current fit-relative zoom and panned source center');
const second=mount(new Element(),new Element(large),'main:2');assertScale(second.viewport,second.img,1,base);fullFit(second.viewport,second.img);second.zoomAt(3);const revisited=mount(new Element(),new Element(large),'main:1');assertScale(revisited.viewport,revisited.img,1,base);fullFit(revisited.viewport,revisited.img);assert.equal(nodes.get('#figure-scale-output').textContent,'100%');
console.log('PASS each different figure selection and revisit starts complete, without restoring obsolete per-figure zoom');
revisited.zoomAt(2);const resizeBefore=pixels(revisited.viewport,revisited.img,{x:200,y:300});revisited.viewport.clientWidth=300;revisited.viewport.clientHeight=400;images.refresh();assertScale(revisited.viewport,revisited.img,2,.25);const resizeAfter=pixels(revisited.viewport,revisited.img,{x:150,y:200});near(resizeBefore.x,resizeAfter.x);near(resizeBefore.y,resizeAfter.y);revisited.reset();assertScale(revisited.viewport,revisited.img,1,.25);fullFit(revisited.viewport,revisited.img);assert.equal(revisited.viewport.style.aspectRatio,undefined);
console.log('PASS resize recomputes contain base while preserving relative zoom and source center; reset fits current frame');
const currentInput=nodes.get('#figure-initial-scale');assert.equal(currentInput.value,'1');currentInput.value='1.6';currentInput.emit('change');assertScale(revisited.viewport,revisited.img,1.6,.25);assert.equal(currentInput.value,'1.6');assert.equal(preference,7,'Legacy preference callback must not be called');assert.equal(nodes.get('#figure-scale-output').textContent,'160%');revisited.zoomAt(1.1);near(Number(currentInput.value),1.76);currentInput.value='invalid';currentInput.emit('change');near(Number(currentInput.value),1.76);currentInput.value='100';currentInput.emit('change');assertScale(revisited.viewport,revisited.img,8,.25);assert.equal(currentInput.value,'8');const freshAfterInput=mount(new Element(),new Element(large),'after-current-input');assertScale(freshAfterInput.viewport,freshAfterInput.img,1,base);assert.equal(currentInput.value,'1');freshAfterInput.zoomAt(2);images.fitFigure();fullFit(freshAfterInput.viewport,freshAfterInput.img);assert.equal(currentInput.value,'1');assert.equal(nodes.get('#figure-scale-output').textContent,'100%');
console.log('PASS current-scale input follows wheel/reset, clamps explicit input and never persists or changes new-figure defaults');
const portraitView=new Element({width:500,height:320}),portrait=new Element({naturalWidth:600,naturalHeight:1800});mount(portraitView,portrait,'portrait');fullFit(portraitView,portrait);near(actualScale(portrait),320/1800);assert.equal(portraitView.style.height,undefined);assert.equal(portraitView.style.aspectRatio,undefined);
console.log('PASS tall image uses height cap without crop/stretch or taking over root-owned frame dimensions');
const unloadedView=new Element(),unloadedImage=new Element(),loading=mount(unloadedView,unloadedImage,'loading');assert.equal(loading.snapshot().centerX,.5);assert.equal(loading.snapshot().pixelScale,0);assert.equal(unloadedImage.style.transform,undefined);loading.reset(2);assert.equal(currentInput.value,'2');images.fitFigure();assert.equal(loading.snapshot().relative,1);assert.equal(currentInput.value,'1');assert.equal(nodes.get('#figure-scale-output').textContent,'100%');unloadedImage.naturalWidth=1000;unloadedImage.naturalHeight=500;unloadedImage.emit('load');fullFit(unloadedView,unloadedImage);assertScale(unloadedView,unloadedImage,1,.4);
console.log('PASS reset before natural dimensions load records fit and synchronizes controls, then loads with no invalid transform');
body.style.setProperty('position','relative','important');const focus=document.activeElement;images.openZoom('test-modal');const dialog=nodes.get('#image-dialog'),zoomImage=nodes.get('#zoom-image'),stage=nodes.get('#image-scroll'),fitScale=Math.min((stage.clientWidth-16)/zoomImage.naturalWidth,(stage.clientHeight-16)/zoomImage.naturalHeight);assert.equal(dialog.open,true);assertScale(stage,zoomImage,1,fitScale);fullFit(stage,zoomImage,8);assert.equal(body.style.getPropertyValue('position'),'fixed');dialog.emit('click',{target:zoomImage});assert.equal(dialog.open,true);dialog.emit('click',{target:nodes.get('#image-tools')});assert.equal(dialog.open,true);assert.equal(dialog.emit('wheel',{deltaY:80}).defaultPrevented,true);dialog.emit('click',{target:stage});assert.equal(dialog.open,false);assert.equal(window.scrollX,13);assert.equal(window.scrollY,728);assert.equal(document.activeElement,focus);assert.equal(body.style.getPropertyValue('position'),'relative');assert.equal(body.style.getPropertyPriority('position'),'important');
console.log('PASS modal remains complete fit with outside margin; blank close restores scroll, focus and body styles (DOM stub)');
images.openZoom('test-modal');const blankWheel=stage.emit('wheel',{target:stage,clientX:1,clientY:1,deltaY:-80,deltaMode:0});assert.equal(blankWheel.defaultPrevented,false);assert.equal(Number(zoomImage.dataset.imageScale),1);assert.equal(dialog.emit('wheel',blankWheel).defaultPrevented,true);assert.equal(body.style.getPropertyValue('position'),'fixed');const modalImageWheel=stage.emit('wheel',{target:zoomImage,clientX:200,clientY:300,deltaY:-80,deltaMode:0});assert.equal(modalImageWheel.defaultPrevented,true);assert.ok(Number(zoomImage.dataset.imageScale)>1);images.zoomBy(1e8);assertScale(stage,zoomImage,8,fitScale);images.zoomBy(1e-8);assertScale(stage,zoomImage,.5,fitScale);images.fitZoom();assertScale(stage,zoomImage,1,fitScale);fullFit(stage,zoomImage,8);
console.log('PASS modal image wheel and .5–8 fit-relative bounds remain; blank wheel only locks article scrolling');
stage.emit('pointerdown',{target:zoomImage,button:0,isPrimary:true,pointerId:2,clientX:200,clientY:300});stage.emit('pointerup',{pointerId:2,clientX:200,clientY:300});const retargetedClick=stage.emit('click',{target:stage});assert.equal(retargetedClick.defaultPrevented,true);assert.equal(retargetedClick.stopped,true);assert.equal(dialog.open,true);dialog.emit('pointerdown',{target:stage});dialog.emit('click',{target:stage});assert.equal(dialog.open,false);
console.log('PASS captured ordinary image click retains modal; subsequent blank gesture closes immediately');
const offsetView=new Element({left:43,top:91}),offsetImage=new Element({naturalWidth:200,naturalHeight:100}),offset=mount(offsetView,offsetImage,'offset'),offsetScale=Number(offsetView.dataset.imagePixelScale);assert.equal(offsetView.emit('wheel',{target:offsetImage,clientX:243,clientY:391,deltaY:-80,deltaMode:0}).defaultPrevented,true);assert.ok(Number(offsetView.dataset.imagePixelScale)>offsetScale);offset.reset();assert.equal(offsetView.emit('wheel',{target:offsetImage,clientX:243,clientY:100,deltaY:-80,deltaMode:0}).defaultPrevented,false);assertScale(offsetView,offsetImage,1,2);fullFit(offsetView,offsetImage);
console.log('PASS actual-image hit test respects offset frame, contain reset and letterbox scroll boundaries');
images.destroy();
