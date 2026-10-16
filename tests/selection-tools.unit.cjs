'use strict';
// State/geometry regression only. These DOM stubs do not claim native touch or
// rendered browser acceptance; the real Chrome gate remains reader-v150.cjs.
const test=require('node:test'),assert=require('node:assert/strict');
const tools=require('../assets/reader/selection-tools.js');

class Events{
  constructor(){this.events=new Map();}
  addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
  removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
  emit(name,extra={}){const e={target:this,button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};for(const fn of [...this.events.get(name)||[]])fn(e);return e;}
  count(){return [...this.events.values()].reduce((n,set)=>n+set.size,0);}
}
class Element extends Events{
  constructor(doc,tag='div'){super();this.ownerDocument=doc;this.nodeType=1;this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.isConnected=true;this.attributes={};this.dataset={};this.style={};this.rect={left:0,right:290,top:0,bottom:50,width:290,height:50};this.clientLeft=this.clientTop=0;}
  get clientWidth(){return this.rect.width;}get clientHeight(){return this.rect.height;}get offsetWidth(){return this.rect.width;}get offsetHeight(){return this.rect.height;}
  append(node){node.parentElement=this;this.children.push(node);}
  replaceChildren(){for(const child of this.children)child.parentElement=null;this.children=[];}
  setAttribute(key,value){this.attributes[key]=String(value);}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  closest(selector){if(selector==='button'&&this.tagName==='BUTTON')return this;return this.parentElement?.closest(selector)||null;}
  matches(){return ['INPUT','TEXTAREA','SELECT'].includes(this.tagName);}
  getBoundingClientRect(){return this.rect;}
  focus(){this.ownerDocument.activeElement=this;this.parentElement?.emit('focusin',{target:this});this.ownerDocument.emit('focusin',{target:this});}
}
class Range{
  constructor(node,start=0,end=8,rects){this.startContainer=this.endContainer=node;this.startOffset=start;this.endOffset=end;this.rects=rects||[{left:90,right:200,top:200,bottom:225,width:110,height:25}];}
  get collapsed(){return this.startOffset===this.endOffset;}
  cloneRange(){return new Range(this.startContainer,this.startOffset,this.endOffset,this.rects);}
  getClientRects(){return this.rects;}
}
function setup({toolbarBottom}={}){
  const doc=new Events(),win=new Events(),frames=new Map();let frameId=0,enabled=true;
  doc.defaultView=win;doc.createElement=tag=>new Element(doc,tag);win.innerWidth=390;win.innerHeight=800;win.setTimeout=setTimeout;win.getComputedStyle=node=>({overflowX:node.style.overflowX||'visible',overflowY:node.style.overflowY||'visible',display:node.style.display||'block',visibility:node.style.visibility||'visible'});
  win.requestAnimationFrame=fn=>{const id=++frameId;frames.set(id,fn);return id;};win.cancelAnimationFrame=id=>frames.delete(id);
  win.visualViewport=new Events();Object.assign(win.visualViewport,{offsetLeft:0,offsetTop:0,width:390,height:800});
  const body=new Element(doc),reader=new Element(doc),element=new Element(doc),text=new Element(doc,'p');body.append(reader);body.append(element);reader.append(text);text.text='Original selected text 甲😀乙';text.blockId='body';doc.activeElement=body;
  const toolbar=toolbarBottom===undefined?null:new Element(doc);if(toolbar){Object.assign(toolbar.rect,{left:0,right:390,top:0,bottom:toolbarBottom,width:390,height:toolbarBottom});body.append(toolbar);}
  let selection={isCollapsed:false,rangeCount:1,focusNode:text,focusOffset:8,getRangeAt(){return this.range;},range:new Range(text)};win.getSelection=()=>selection;
  const highlights=[],notes=[],errors=[];
  const api=tools.create({element,reader,toolbar,readSelection:range=>({blockId:range.startContainer.blockId,language:'en',start:range.startOffset,end:range.endOffset,quote:range.startContainer.text.slice(range.startOffset,range.endOffset),color:'yellow',note:''}),onHighlight:(a,color)=>highlights.push({annotation:a,color}),onNote:a=>notes.push(a),isEnabled:()=>enabled,onError:error=>errors.push(error)});
  return {doc,win,body,reader,element,text,toolbar,api,highlights,notes,errors,frames,buttons:element.children,
    select(start,end,node=text){selection={isCollapsed:start===end,rangeCount:1,focusNode:node,focusOffset:end,range:new Range(node,start,end),getRangeAt(){return this.range;}};},
    collapse(){selection={isCollapsed:true,rangeCount:0};},selection:()=>selection,disable(){enabled=false;},
    flush(){for(const fn of [...frames.values()])fn();frames.clear();},click(button){element.emit('pointerdown',{target:button});element.emit('click',{target:button});}};
}

test('five direct colors and note action do not steal focus or mutate the native range',()=>{
  const x=setup(),selection=x.selection();x.api.refresh();
  assert.equal(x.element.hidden,false);assert.equal(x.doc.activeElement,x.body);assert.equal(x.selection(),selection);
  assert.deepEqual(x.buttons.slice(0,5).map(button=>button.dataset.highlightColor),['yellow','green','blue','pink','orange']);
  assert.equal(x.buttons[5].textContent,'添加笔记');assert.equal(x.element.attributes.role,'toolbar');
  assert(x.buttons.every(button=>button.attributes['aria-label']));x.api.destroy();
});
test('visible viewport offsets and every edge keep the toolbar fully within view',()=>{
  const viewport={left:160,top:250,width:320,height:420},toolbar={width:290,height:50};
  for(const rect of [
    {left:160,right:170,top:251,bottom:275},{left:470,right:480,top:251,bottom:275},
    {left:160,right:170,top:640,bottom:668},{left:470,right:480,top:640,bottom:668},
    {left:210,right:420,top:390,bottom:415}]){
    const p=tools.calculatePosition({rect,toolbar,viewport});
    assert(p.left>=168&&p.left+toolbar.width<=472);assert(p.top>=258&&p.top+toolbar.height<=662);
    assert.equal(p.placement,rect.top<300?'below':'above');
  }
});
test('top selection flips below the occupied sticky toolbar while bottom selection remains above',()=>{
  const x=setup({toolbarBottom:136});Object.assign(x.selection().range.rects[0],{top:171,bottom:196});x.api.refresh();
  assert.equal(x.element.hidden,false);assert.equal(x.element.dataset.placement,'below');assert.equal(Number.parseFloat(x.element.style.top),205);assert(Number.parseFloat(x.element.style.top)>=144);
  Object.assign(x.selection().range.rects[0],{top:760,bottom:785});x.api.refresh();
  assert.equal(x.element.dataset.placement,'above');assert.equal(Number.parseFloat(x.element.style.top),701);assert(Number.parseFloat(x.element.style.top)+50<=792);x.api.destroy();
});
test('occupied toolbar clips selection visibility and hidden/offscreen controls reserve no space',()=>{
  const x=setup({toolbarBottom:136});Object.assign(x.selection().range.rects[0],{top:110,bottom:130});x.api.refresh();assert.equal(x.element.hidden,true);
  x.toolbar.hidden=true;x.api.refresh();assert.equal(x.element.hidden,false);assert.equal(x.element.dataset.placement,'above');
  x.toolbar.hidden=false;x.toolbar.style.visibility='hidden';x.api.refresh();assert.equal(x.element.hidden,false);
  x.toolbar.style.visibility='visible';Object.assign(x.win.visualViewport,{offsetTop:250,height:400});Object.assign(x.selection().range.rects[0],{top:270,bottom:295});x.api.refresh();
  assert.equal(x.element.hidden,false);assert.equal(x.element.dataset.placement,'below');assert.equal(Number.parseFloat(x.element.style.top),304);x.api.destroy();
});
test('tiny visual viewport hides actions instead of covering sticky controls or overflowing',()=>{
  for(const geometry of [{width:390,height:180},{width:250,height:800},{width:390,height:0}]){
    const x=setup({toolbarBottom:136});Object.assign(x.selection().range.rects[0],{top:150,bottom:170});Object.assign(x.win.visualViewport,geometry);x.api.refresh();
    assert.equal(x.element.hidden,true);x.click(x.buttons[0]);assert.equal(x.highlights.length,0);x.api.destroy();
  }
});
test('viewport shrink before the next positioning callback rejects stale visible actions',()=>{
  const x=setup({toolbarBottom:136});Object.assign(x.selection().range.rects[0],{top:150,bottom:170});x.api.refresh();assert.equal(x.element.hidden,false);
  x.win.visualViewport.height=180;x.click(x.buttons[5]);assert.equal(x.notes.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
});
test('mouse and touch pointerdown prevent focus loss; validated clone survives browser collapse',()=>{
  for(const pointerType of ['mouse','touch']){
    const x=setup();x.api.refresh();const button=x.buttons[4];
    assert.equal(x.element.emit('pointerdown',{target:button,pointerType}).defaultPrevented,true);x.collapse();x.element.emit('click',{target:button});
    assert.equal(x.highlights.length,1);assert.equal(x.highlights[0].color,'orange');assert.equal(x.highlights[0].annotation.quote,'Original');assert.equal(x.element.hidden,true);x.api.destroy();
  }
});
test('keyboard shortcut, roving focus and a collapsed native selection keep the same note anchor',()=>{
  const x=setup();assert.equal(x.doc.emit('keydown',{key:'F10',shiftKey:true}).defaultPrevented,true);assert.equal(x.doc.activeElement,x.buttons[0]);
  x.collapse();x.element.emit('keydown',{key:'End'});assert.equal(x.doc.activeElement,x.buttons[5]);assert.equal(x.buttons[5].tabIndex,0);assert.equal(x.buttons[0].tabIndex,-1);
  x.api.refresh();x.element.emit('click',{target:x.buttons[5]});assert.equal(x.notes.length,1);assert.equal(x.notes[0].quote,'Original');assert.equal(x.highlights.length,0);x.api.destroy();
});
test('text changed under a live range is rejected even if the native range also still exists',()=>{
  const x=setup();x.api.refresh();x.text.text='Replaced selected text';x.click(x.buttons[3]);
  assert.equal(x.highlights.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
});
test('detached/replaced original nodes cannot apply stale highlights',()=>{
  const x=setup();x.api.refresh();x.text.isConnected=false;x.click(x.buttons[2]);assert.equal(x.highlights.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
});
test('connected selection hidden after display cannot act on a stale toolbar',()=>{
  for(const index of [3,5]){
    const x=setup();x.api.refresh();assert.equal(x.element.hidden,false);
    // A caption can stay connected and retain valid canonical text while its
    // ancestor becomes hidden before the next refresh/scroll callback runs.
    x.selection().range.rects.length=0;x.click(x.buttons[index]);
    assert.equal(x.highlights.length,0);assert.equal(x.notes.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
  }
});
test('a newer native range outside the visible viewport cannot bypass action visibility checks',()=>{
  const x=setup();x.api.refresh();x.select(9,17);Object.assign(x.selection().range.rects[0],{top:900,bottom:925});x.click(x.buttons[1]);
  assert.equal(x.highlights.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
});
test('overflow ancestor clipping rejects text inside the window but scrolled outside its pane',()=>{
  for(const overflow of ['auto','scroll','hidden','clip'])for(const index of [0,5]){
    const x=setup(),pane=new Element(x.doc);Object.assign(pane.rect,{left:30,right:350,top:170,bottom:300,width:320,height:130});pane.style.overflowY=overflow;x.reader.append(pane);pane.append(x.text);
    x.api.refresh();assert.equal(x.element.hidden,false);
    Object.assign(x.selection().range.rects[0],{top:310,bottom:335});x.click(x.buttons[index]);
    assert.equal(x.highlights.length,0);assert.equal(x.notes.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
  }
});
test('positioning uses the visible fragment inside nested horizontal and vertical clips',()=>{
  const x=setup(),pane=new Element(x.doc),inner=new Element(x.doc);
  Object.assign(pane.rect,{left:100,right:250,top:210,bottom:300,width:150,height:90});pane.style.overflowY='auto';pane.clientTop=2;
  Object.assign(inner.rect,{left:180,right:230,top:0,bottom:700,width:50,height:700});inner.style.overflowX='hidden';inner.clientLeft=2;
  x.reader.append(pane);pane.append(inner);inner.append(x.text);x.api.refresh();
  assert.equal(x.element.hidden,false);
  // Selected fragment is x=182..200,y=212..225, so the toolbar centers at 191
  // and sits above y=212, rather than using the unclipped range's x=90,y=200.
  assert.equal(Number.parseFloat(x.element.style.left),46);assert.equal(Number.parseFloat(x.element.style.top),153);
  Object.assign(x.selection().range.rects[0],{left:30,right:70});x.doc.emit('scroll');x.flush();assert.equal(x.element.hidden,true);x.api.destroy();
});
test('latest deliberate native selection is re-read before action, including UTF-16 anchors',()=>{
  const x=setup();x.api.refresh();const start=x.text.text.indexOf('😀');x.select(start,start+2);x.click(x.buttons[3]);
  assert.equal(x.highlights[0].annotation.quote,'😀');assert.equal(x.highlights[0].annotation.start,start);assert.equal(x.highlights[0].annotation.end,start+2);x.api.destroy();
});
test('outside pointer or control focus dismisses the toolbar and invalidates the saved range',()=>{
  for(const action of ['pointer','focus']){
    const x=setup();x.api.refresh();if(action==='pointer')x.doc.emit('pointerdown',{target:x.body});else{const input=new Element(x.doc,'input');x.body.append(input);input.focus();}
    x.collapse();x.element.emit('click',{target:x.buttons[0]});assert.equal(x.highlights.length,0);assert.equal(x.element.hidden,true);x.api.destroy();
  }
});
test('collapsed or foreign selections cannot create a floating action',()=>{
  const x=setup();x.collapse();x.api.refresh();assert.equal(x.element.hidden,true);
  const outside=new Element(x.doc,'p');outside.text='Outside text';x.body.append(outside);x.select(0,7,outside);x.api.refresh();assert.equal(x.element.hidden,true);x.api.destroy();
});
test('scrolling outside view, disabling reading and Escape dismiss without mutating selection',()=>{
  for(const action of ['scroll','disable','escape']){
    const x=setup();x.api.refresh();const selection=x.selection();
    if(action==='scroll'){x.selection().range.rects[0].top=-100;x.selection().range.rects[0].bottom=-80;x.doc.emit('scroll');x.flush();}
    else if(action==='disable'){x.disable();x.api.refresh();}else x.doc.emit('keydown',{key:'Escape'});
    assert.equal(x.element.hidden,true);assert.equal(x.selection(),selection);x.api.destroy();
  }
});
test('visual viewport scroll repositions and destroy removes all owned listeners/frames',()=>{
  const x=setup();x.api.refresh();x.win.visualViewport.offsetLeft=50;x.win.visualViewport.width=320;x.win.visualViewport.emit('scroll');x.flush();assert(Number.parseFloat(x.element.style.left)>=58);
  x.doc.emit('scroll');assert(x.frames.size);x.api.destroy();assert.equal(x.frames.size,0);assert.equal(x.element.count(),0);assert.equal(x.doc.count(),0);assert.equal(x.win.count(),0);assert.equal(x.win.visualViewport.count(),0);assert.equal(x.element.hidden,true);
});
