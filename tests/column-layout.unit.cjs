'use strict';
// DOM-stub unit tests only. Actual grid geometry and rendering need Chrome QA.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../assets/reader/column-layout.js'),'utf8');

class Events {
  constructor(){this.events=new Map();}
  addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
  removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
  emit(name,values={}){const e={button:0,pointerId:1,isPrimary:true,clientX:200,buttons:1,prevented:false,stopped:false,
    preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...values};
    for(const fn of [...(this.events.get(name)||[])])fn(e);return e;}
  count(){return [...this.events.values()].reduce((n,s)=>n+s.size,0);}
}
class Style {
  constructor(){this.values=new Map();this.priorities=new Map();}
  setProperty(k,v,p=''){this.values.set(k,String(v));this.priorities.set(k,p);}
  getPropertyValue(k){return this.values.get(k)||'';}
  getPropertyPriority(k){return this.priorities.get(k)||'';}
  removeProperty(k){this.values.delete(k);this.priorities.delete(k);}
}
class Element extends Events {
  constructor(doc,id=''){super();this.ownerDocument=doc;this.id=id;this.parentElement=null;this.children=[];this.attrs=new Map();this.style=new Style();this.capture=new Set();
    this.classList={contains:c=>(this.getAttribute('class')||'').split(/\s+/).includes(c),
      add:c=>this.setAttribute('class',[...new Set((this.getAttribute('class')||'').split(/\s+/).filter(Boolean).concat(c))].join(' ')),
      remove:c=>this.setAttribute('class',(this.getAttribute('class')||'').split(/\s+/).filter(x=>x&&x!==c).join(' '))};}
  get hidden(){return this.attrs.has('hidden');}set hidden(v){v?this.setAttribute('hidden',''):this.removeAttribute('hidden');}
  setAttribute(k,v){this.attrs.set(k,String(v));}getAttribute(k){return this.attrs.has(k)?this.attrs.get(k):null;}removeAttribute(k){this.attrs.delete(k);}
  insertBefore(node,before){node.parentElement?.removeChild(node);const i=this.children.indexOf(before);this.children.splice(i<0?this.children.length:i,0,node);node.parentElement=this;return node;}
  append(node){return this.insertBefore(node,null);}removeChild(node){this.children.splice(this.children.indexOf(node),1);node.parentElement=null;}
  remove(){this.parentElement?.removeChild(this);}
  querySelector(selector){const id=selector.slice(1);for(const node of this.children){if(node.id===id)return node;const found=node.querySelector(selector);if(found)return found;}return null;}
  focus(){this.ownerDocument.activeElement=this;}
  setPointerCapture(id){if(this.captureFailure)throw Error('capture unavailable');this.capture.add(id);}
  hasPointerCapture(id){return this.capture.has(id);}releasePointerCapture(id){this.capture.delete(id);}
}
function setup({width=1140,rootWidth=width,settings,existing=false,onResize}={}){
  const win=new Events(),doc=new Events(),frames=new Map();let serial=0,notifications=0;
  doc.defaultView=win;doc.hidden=false;doc.createElement=()=>new Element(doc);doc.documentElement=new Element(doc,'html');
  win.innerWidth=width;win.getComputedStyle=node=>({paddingLeft:node===root?'14px':'0',paddingRight:node===root?'14px':'0',display:node.hidden?'none':'grid'});
  win.requestAnimationFrame=fn=>{const id=++serial;frames.set(id,fn);return id;};win.cancelAnimationFrame=id=>frames.delete(id);
  const observers=[];
  class Observer{constructor(fn){this.fn=fn;this.connected=true;observers.push(this);}observe(){}disconnect(){this.connected=false;}trigger(){if(this.connected)this.fn();}}
  win.ResizeObserver=win.MutationObserver=Observer;
  Object.defineProperty(win,'localStorage',{get(){throw Error('No storage access allowed');}});
  const root=new Element(doc,'main'),sidebar=new Element(doc,'sidebar'),reader=new Element(doc,'reader-view'),article=new Element(doc,'article'),figure=new Element(doc,'figure-pane'),sourceView=new Element(doc,'source-view'),notes=new Element(doc,'notes-view');
  root.clientWidth=rootWidth;sourceView.hidden=notes.hidden=true;root.append(sidebar);root.append(reader);root.append(sourceView);root.append(notes);reader.append(article);reader.append(figure);
  if(existing){const a=new Element(doc,'sidebar-splitter'),b=new Element(doc,'figure-splitter');a.setAttribute('role','presentation');a.hidden=true;root.insertBefore(a,reader);reader.insertBefore(b,figure);}
  vm.runInNewContext(source,{window:win,globalThis:win});let api;
  api=win.MicroPaperColumns.create({root,reader,settings,onResize:state=>{notifications++;onResize?.(state,api);}});
  return {win,doc,root,sidebar,reader,article,figure,sourceView,notes,api,observers,frames,
    handles:()=>[root.querySelector('#sidebar-splitter'),reader.querySelector('#figure-splitter')],
    notifications:()=>notifications,flush(){for(let n=0;frames.size;n++){assert.ok(n<20,'No observer/RAF cycle');const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());}},
    resize(w){win.innerWidth=w;root.clientWidth=w;win.emit('resize');this.flush();}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function fits(s){near(s.sidebarWidth+s.articleWidth+s.figureWidth+24,s.contentWidth);assert.ok(s.sidebarWidth>=s.limits.sidebarMin);assert.ok(s.articleWidth>=s.limits.articleMin);assert.ok(s.figureWidth>=s.limits.figureMin);}

test('handles inserted at correct boundaries, accessible, and no storage required',()=>{
  const x=setup(),[a,b]=x.handles();assert.deepEqual(x.root.children.map(n=>n.id),['sidebar','sidebar-splitter','reader-view','source-view','notes-view']);
  assert.deepEqual(x.reader.children.map(n=>n.id),['article','figure-splitter','figure-pane']);
  for(const h of[a,b]){assert.equal(h.getAttribute('role'),'separator');assert.equal(h.getAttribute('aria-orientation'),'vertical');assert.equal(h.getAttribute('tabindex'),'0');assert.equal(h.hidden,false);assert.ok(h.getAttribute('aria-label'));}
  assert.equal(x.api.getState().enabled,true);fits(x.api.getState());x.api.destroy();
});
test('800/801 desktop boundary and narrow/wide budgets never add the old gaps',()=>{
  const x=setup({width:800});assert.equal(x.api.getState().enabled,false);x.handles().forEach(h=>assert.equal(h.hidden,true));
  for(const w of[801,850,1000,1140,1800,2400]){x.resize(w);const s=x.api.getState();assert.equal(s.enabled,true);fits(s);assert.ok(s.articleWidth>=280);assert.ok(s.figureWidth>=240);}
  x.resize(800);assert.equal(x.api.getState().mode,'mobile');assert.equal(x.sidebar.style.getPropertyValue('width'),'');assert.equal(x.figure.style.getPropertyValue('width'),'');x.api.destroy();
});
test('sidebar and article dragging clamp jointly and ignore other pointers',()=>{
  const x=setup({width:801}),[a,b]=x.handles();a.emit('pointerdown',{clientX:100});x.win.emit('pointermove',{clientX:-1000});assert.equal(x.api.getState().sidebarWidth,140);
  const held=x.api.getState().sidebarWidth;x.win.emit('pointermove',{pointerId:2,clientX:5000});assert.equal(x.api.getState().sidebarWidth,held);
  x.win.emit('pointermove',{clientX:5000});near(x.api.getState().sidebarWidth,x.api.getState().limits.sidebarMax);fits(x.api.getState());x.win.emit('pointerup');
  b.emit('pointerdown',{clientX:400});x.win.emit('pointermove',{clientX:-5000});near(x.api.getState().articleWidth,280);fits(x.api.getState());
  x.win.emit('pointermove',{clientX:5000});near(x.api.getState().figureWidth,240);fits(x.api.getState());x.win.emit('pointerup');assert.equal(x.api.getState().dragging,null);x.api.destroy();
});
test('nonprimary, right button and a second pointer cannot start or steal a drag',()=>{
  const x=setup(),[a,b]=x.handles();for(const values of[{button:2},{isPrimary:false},{clientX:NaN}]){assert.equal(a.emit('pointerdown',values).prevented,false);assert.equal(x.api.getState().dragging,null);}
  a.emit('pointerdown');b.emit('pointerdown',{pointerId:2});assert.equal(x.api.getState().dragging,'sidebar');assert.equal(a.hasPointerCapture(1),true);assert.equal(b.hasPointerCapture(2),false);x.api.destroy();
});
test('up, cancel, lost capture, blur and visibility loss restore selection/capture',()=>{
  for(const end of['pointerup','pointercancel','lostpointercapture','blur','visibilitychange'])for(const index of[0,1]){
    const x=setup(),h=x.handles()[index];h.emit('pointerdown');assert.equal(x.doc.documentElement.classList.contains('micro-paper-columns-dragging'),true);
    if(end==='lostpointercapture')h.emit(end);else if(end==='visibilitychange'){x.doc.hidden=true;x.doc.emit(end);}else x.win.emit(end);
    assert.equal(x.api.getState().dragging,null,end);assert.equal(h.hasPointerCapture(1),false,end);assert.equal(x.doc.documentElement.classList.contains('micro-paper-columns-dragging'),false,end);
    const held=x.api.getState().sidebarWidth;x.win.emit('pointermove',{clientX:999});assert.equal(x.api.getState().sidebarWidth,held);x.api.destroy();
  }
});
test('failed capture still drags through window events and released buttons stop it',()=>{
  const x=setup(),a=x.handles()[0];a.captureFailure=true;a.emit('pointerdown',{clientX:100});x.win.emit('pointermove',{clientX:150});assert.equal(x.api.getState().dragging,'sidebar');
  x.win.emit('pointermove',{buttons:0});assert.equal(x.api.getState().dragging,null);assert.equal(x.doc.documentElement.classList.contains('micro-paper-columns-dragging'),false);x.api.destroy();
});
test('resize or reader/source/notes switches end dragging without overwriting preferences',()=>{
  const x=setup(),[a,b]=x.handles();a.emit('keydown',{key:'End'});const desired=x.api.getSettings().sidebarWidth;b.emit('pointerdown');x.resize(800);assert.equal(x.api.getState().dragging,null);
  x.resize(1140);near(x.api.getState().sidebarWidth,desired);a.emit('pointerdown');x.reader.hidden=true;x.sourceView.hidden=false;x.observers.forEach(o=>o.trigger());x.flush();
  assert.equal(x.api.getState().mode,'other');assert.equal(x.api.getState().dragging,null);x.handles().forEach(h=>assert.equal(h.hidden,true));assert.equal(x.sourceView.hidden,false);assert.equal(x.notes.hidden,true);
  x.reader.hidden=false;x.sourceView.hidden=true;x.api.refresh();near(x.api.getState().sidebarWidth,desired);fits(x.api.getState());x.api.destroy();
});
test('keyboard arrows/Home/End update ARIA and stop consumed global reader shortcuts',()=>{
  const x=setup(),[a,b]=x.handles();for(const [h,key,width]of[[a,'Home','sidebarWidth'],[a,'End','sidebarWidth'],[b,'Home','articleWidth'],[b,'End','articleWidth']]){
    const e=h.emit('keydown',{key});assert.equal(e.prevented,true);assert.equal(e.stopped,true);near(Number(h.getAttribute('aria-valuenow')),Math.round(x.api.getState()[width]));fits(x.api.getState());
  }
  a.emit('keydown',{key:'Home'});const start=x.api.getState().sidebarWidth;a.emit('keydown',{key:'ArrowRight'});near(x.api.getState().sidebarWidth,start+10);a.emit('keydown',{key:'ArrowRight',shiftKey:true});near(x.api.getState().sidebarWidth,start+50);
  const held=x.api.getState().sidebarWidth;for(const values of[{key:'x'},{key:'ArrowRight',ctrlKey:true}]){assert.equal(a.emit('keydown',values).prevented,false);near(x.api.getState().sidebarWidth,held);}x.api.destroy();
});
test('default reset/double-click and invalid settings are bounded, state is a copy',()=>{
  const x=setup({settings:{sidebarWidth:1e20,articleFraction:NaN}});fits(x.api.getState());const state=x.api.getState();state.limits.sidebarMin=-10;assert.notEqual(x.api.getState().limits.sidebarMin,-10);
  x.handles()[0].emit('dblclick');const s=x.api.getState();near(s.articleWidth,s.figureWidth);assert.ok(s.sidebarWidth<=210);assert.equal(x.api.getSettings().sidebarWidth,null);
  const pref=x.api.getSettings();pref.articleFraction=-1;assert.equal(x.api.getSettings().articleFraction,.5);x.api.destroy();
});
test('unchanged refresh/observer callbacks do not loop or repeatedly notify',()=>{
  let calls=0;const x=setup({onResize:(_s,api)=>{calls++;api?.refresh();}});assert.equal(calls,1);for(let n=0;n<5;n++){x.api.refresh();x.observers.forEach(o=>o.trigger());x.flush();}assert.equal(calls,1);
  x.root.clientWidth=1300;x.observers[0].trigger();x.flush();assert.equal(calls,2);x.api.destroy();
});
test('destroy mid-drag restores original DOM/vars and removes pending work/listeners',()=>{
  const x=setup({existing:true}),[a,b]=x.handles();a.emit('pointerdown');x.observers[0].trigger();assert.ok(x.frames.size);x.api.destroy();
  assert.equal(x.frames.size,0);assert.equal(x.win.count(),0);assert.equal(x.doc.count(),0);assert.equal(a.count(),0);assert.equal(b.count(),0);assert.equal(a.getAttribute('role'),'presentation');assert.equal(a.hidden,true);
  assert.equal(a.hasPointerCapture(1),false);assert.equal(x.root.classList.contains('micro-paper-columns'),false);assert.equal(x.root.getAttribute('data-columns-mode'),null);assert.equal(x.root.style.getPropertyValue('--sidebar-width'),'');
  const held=x.api.getState().sidebarWidth;x.win.emit('pointermove',{clientX:900});x.win.emit('resize');x.flush();assert.equal(x.api.getState().sidebarWidth,held);x.api.destroy();
  const y=setup();y.api.destroy();assert.equal(y.root.querySelector('#sidebar-splitter'),null);assert.equal(y.reader.querySelector('#figure-splitter'),null);
});
