'use strict';
// Index/controller tests use self-authored fixtures and a DOM stub. Browser
// pointer selection, native link behaviour and layout require the Chrome gate.
const test=require('node:test'),assert=require('node:assert/strict');
const refs=require('../assets/reader/reference-links.js');
const provenance={pageId:'p1',review:'self-authored-test'};
function paper(){return {blocks:[{blockId:'body',kind:'body',en:'A😀 evidence1–3,5 end. Other5,3 claim. Single2.',zh:'甲😀证据1–3,5。另见5,3。单条2。'},...[1,2,3,5].map(number=>({blockId:'ref-'+number,kind:'reference',en:number+'. Example Author. Self-authored reference '+number+'.',zh:number+'. 自写参考文献。'}))],referenceTargets:[1,2,3,5].map(number=>({number,blockId:'ref-'+number,sourceEvidence:provenance})),referenceCitations:[]};}
function citation(p,exactText='1–3,5',language='en',extra={}){const block=p.blocks[0],start=block[language].indexOf(exactText);return {blockId:block.blockId,language,start,end:start+exactText.length,exactText,numbers:exactText==='1–3,5'?[1,2,3,5]:exactText==='5,3'?[5,3]:[2],sourceEvidence:provenance,...extra};}
function fixture(){const p=paper();p.referenceCitations=[citation(p),citation(p,'5,3'),citation(p,'2'),citation(p,'1–3,5','zh')];return p;}

class Events{
 constructor(){this.events=new Map();}
 addEventListener(name,fn){if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(fn);}
 removeEventListener(name,fn){this.events.get(name)?.delete(fn);}
 emit(name,extra={}){const e={target:this,button:0,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};for(const fn of [...this.events.get(name)||[]])fn(e);return e;}
 count(){return [...this.events.values()].reduce((n,s)=>n+s.size,0);}
}
const camel=s=>s.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
class Text{
 constructor(text){this.nodeType=3;this.textContent=text;this.parentElement=null;this.isConnected=true;}
}
class Element extends Events{
 constructor(doc,tag='div'){super();this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.nodeType=1;this.children=[];this.parentElement=null;this.attributes={};this.dataset={};this.style={};this.isConnected=true;this._text='';this.rect={left:50,right:200,top:230,bottom:250,width:150,height:20};}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}set textContent(value){this._text=String(value);this.children=[];}
 get tabIndex(){return Number(this.getAttribute('tabindex')??-1);}set tabIndex(value){this.setAttribute('tabindex',value);}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return Object.hasOwn(this.attributes,name)?this.attributes[name]:null;}hasAttribute(name){return Object.hasOwn(this.attributes,name);}removeAttribute(name){delete this.attributes[name];}
 contains(node){return node===this||this.children.some(child=>child===node||child.nodeType===1&&child.contains(node));}
 matches(selector){return selector.split(',').some(selector=>{selector=selector.trim();if(selector.startsWith('.'))return (this.className||'').split(' ').includes(selector.slice(1));const a=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);if(a){const value=a[1].startsWith('data-')?this.dataset[camel(a[1].slice(5))]:this.getAttribute(a[1]);return value!==undefined&&value!==null&&(a[2]===undefined||value===a[2]);}return this.tagName===selector.toUpperCase();});}
 closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
 querySelectorAll(selector){const found=[];for(const child of this.children)if(child.nodeType===1){if(child.matches(selector))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect(){return this.className==='reference-popover'?{left:0,top:0,right:300,bottom:220,width:300,height:220}:this.rect;}
 focus(){this.ownerDocument.activeElement=this;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;this.isConnected=false;}
}
function setup(p=fixture()){
 const doc=new Events(),win=new Events(),frames=new Map();let serial=0,selection={isCollapsed:true,rangeCount:0};doc.defaultView=win;win.innerWidth=390;win.innerHeight=844;win.setTimeout=setTimeout;win.getSelection=()=>selection;win.getComputedStyle=()=>({display:'block',visibility:'visible'});win.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};win.cancelAnimationFrame=id=>frames.delete(id);
 doc.createElement=tag=>new Element(doc,tag);doc.createTextNode=text=>new Text(text);doc.body=new Element(doc,'body');doc.activeElement=doc.body;doc.getElementById=id=>{const find=node=>{if(node.id===id)return node;for(const child of node.children||[]){const found=find(child);if(found)return found;}return null;};return find(doc.body);};
 const root=new Element(doc,'main'),toolbar=new Element(doc,'nav');Object.assign(toolbar.rect,{left:0,right:390,top:0,bottom:136,width:390,height:136});doc.body.append(root,toolbar);
 for(const target of p.referenceTargets){const el=new Element(doc,'div');el.id=target.blockId;root.append(el);}
 const navigations=[],errors=[],api=refs.create({paper:p,root,toolbar,navigateTo:blockId=>navigations.push(blockId),onError:error=>errors.push(error)});
 return {doc,win,root,toolbar,api,navigations,errors,frames,menu:()=>doc.body.querySelector('.reference-popover'),setSelection:()=>selection={isCollapsed:false,rangeCount:1},clearSelection:()=>selection={isCollapsed:true,rangeCount:0},flush(){const tasks=[...frames.values()];frames.clear();tasks.forEach(fn=>fn());},fragment(citation,start=citation.start,end=citation.end,content){const node=api.wrapFragment(content||doc.createTextNode(citation.exactText.slice(start-citation.start,end-citation.start)),citation,start,end);root.append(node);return node;}};
}

test('canonical UTF16 spans, bilingual groups and lexical number ordering are retained without changing paper',()=>{
 const p=fixture(),before=JSON.stringify(p),index=refs.createIndex(p);
 assert.equal(index.diagnostics.length,0);assert.deepEqual(index.forBlock('body','en').map(c=>c.exactText),['1–3,5','5,3','2']);assert.deepEqual(index.forBlock('body','en')[1].numbers,[5,3]);assert.equal(index.forBlock('body','zh')[0].exactText,'1–3,5');assert.equal(index.forBlock('body','en')[0].start,p.blocks[0].en.indexOf('1–3,5'));assert.equal(JSON.stringify(p),before);
});
test('unknown target, altered quote, split surrogate, missing evidence, non-body classification and duplicate numbers fail closed',()=>{
 const cases=[{numbers:[1,4]}, {exactText:'changed'}, {start:2,end:3,exactText:'\ude00',numbers:[2]}, {sourceEvidence:null}, {numbers:[1,1]}];
 for(const extra of cases){const p=paper();p.referenceCitations=[citation(p,'1–3,5','en',extra)];const index=refs.createIndex(p);assert.equal(index.forBlock('body','en').length,0);assert(index.diagnostics.length);}
 for(const kind of ['title','author','metadata','reference','math','heading']){const p=paper();p.blocks[0].kind=kind;p.referenceCitations=[citation(p)];assert.equal(refs.createIndex(p).forBlock('body','en').length,0);}
});
test('ambiguous targets and overlapping approved spans cannot produce partial or misleading links',()=>{
 const p=fixture();p.referenceTargets.push({...p.referenceTargets[0],blockId:'ref-2'});let index=refs.createIndex(p);assert.equal(index.getTarget(1),undefined);assert.equal(index.getTarget(2),undefined);assert.equal(index.forBlock('body','en').length,1);
 const q=paper(),first=citation(q);q.referenceCitations=[first,{...first,start:first.start+2,exactText:first.exactText.slice(2),numbers:[3,5]}];index=refs.createIndex(q);assert.equal(index.forBlock('body','en').length,0);assert.equal(index.diagnostics.filter(d=>d.reason==='overlapping-approved-spans').length,2);
});
test('old papers or malformed optional reference collections produce no guessed links',()=>{
 for(const p of [{blocks:[]},null,{blocks:[null],referenceTargets:{number:1},referenceCitations:'1'}])assert.deepEqual(refs.createIndex(p).forBlock('body','en'),[]);
});
test('renderer composes links around exact formatted and permanent-highlight fragments without adding prose text',()=>{
 const x=setup(),citation=x.api.forBlock('body','en')[0],before=citation.exactText,prose=new Element(x.doc,'p');let start=citation.start;
 for(const [value,color] of [['1–','pink'],['3,',null],['5','orange']]){const sup=new Element(x.doc,'sup');sup.append(new Text(value));let content=sup;if(color){const mark=new Element(x.doc,'mark');mark.dataset.annotationId='note-'+color;mark.dataset.color=color;mark.append(content);content=mark;}prose.append(x.api.wrapFragment(content,citation,start,start+value.length));start+=value.length;}
 assert.equal(prose.textContent,before);assert.equal(prose.querySelectorAll('sup').length,3);assert.equal(prose.querySelectorAll('[data-annotation-id]').length,2);assert.deepEqual(prose.children.map(n=>n.tabIndex),[0,-1,-1]);assert.equal(prose.children[1].getAttribute('aria-hidden'),'true');assert(prose.children.every(n=>n.dataset.referenceNumbers==='1,2,3,5'));assert.equal(x.menu().parentElement,x.doc.body);assert(!prose.contains(x.menu()));x.api.destroy();
});
test('single citations use native href while group popup exposes every actual target in source order',()=>{
 const x=setup(),all=x.api.forBlock('body','en'),single=x.fragment(all[2]);assert.equal(single.tagName,'A');assert.equal(single.href,'#ref-2');assert.equal(single.draggable,false);
 const multi=x.fragment(all[1]);assert.equal(multi.textContent,'5,3');assert.equal(multi.getAttribute('aria-haspopup'),'dialog');x.root.emit('click',{target:multi});
 assert.equal(x.api.isOpen(),true);assert.equal(x.menu().getAttribute('role'),'dialog');assert.deepEqual(x.menu().querySelectorAll('[data-reference-target-number]').map(link=>[link.dataset.referenceTargetNumber,link.href]),[['5','#ref-5'],['3','#ref-3']]);assert.equal(x.doc.activeElement.dataset.referenceTargetNumber,'5');assert.equal(multi.getAttribute('aria-expanded'),'true');x.api.destroy();
});
test('native selection and clicks on permanent marks preserve selection/note priority without native hash jumps',()=>{
 const x=setup(),citation=x.api.forBlock('body','en')[2],mark=new Element(x.doc,'mark');mark.dataset.annotationId='saved-note';mark.append(new Text(citation.exactText));const anchor=x.fragment(citation,citation.start,citation.end,mark);
 const marked=x.root.emit('click',{target:mark});assert(marked.defaultPrevented);assert.equal(marked.stopped,false);assert.equal(x.navigations.length,0);
 x.setSelection();const selected=x.root.emit('click',{target:anchor});assert(selected.defaultPrevented);assert.equal(x.navigations.length,0);x.clearSelection();x.root.emit('click',{target:anchor});assert.deepEqual(x.navigations,['ref-2']);x.flush();assert.equal(x.doc.activeElement.id,'ref-2');x.api.destroy();
});
test('existing figure controls and mismatching fragment text are never nested or rewritten',()=>{
 const x=setup(),citation=x.api.forBlock('body','en')[2],figure=new Element(x.doc,'span');figure.setAttribute('role','button');figure.append(new Text(citation.exactText));assert.equal(x.api.wrapFragment(figure,citation,citation.start,citation.end),figure);
 const wrong=new Text('3');assert.equal(x.api.wrapFragment(wrong,citation,citation.start,citation.end),wrong);assert.equal(wrong.textContent,'3');x.api.destroy();
});
test('keyboard opens group, arrow/end focus targets, Escape and close restore inline focus',()=>{
 const x=setup(),trigger=x.fragment(x.api.forBlock('body','en')[0]);trigger.focus();const e=x.root.emit('keydown',{target:trigger,key:' '});assert(e.defaultPrevented);assert(x.api.isOpen());assert.equal(x.doc.activeElement.dataset.referenceTargetNumber,'1');
 x.menu().emit('keydown',{key:'ArrowDown'});assert.equal(x.doc.activeElement.dataset.referenceTargetNumber,'2');x.menu().emit('keydown',{key:'End'});assert.equal(x.doc.activeElement.dataset.referenceTargetNumber,'5');
 const tab=x.menu().emit('keydown',{key:'Tab'});assert.equal(tab.defaultPrevented,false,'Tab uses normal native link/close navigation');x.doc.emit('keydown',{key:'Escape'});assert.equal(x.api.isOpen(),false);assert.equal(x.doc.activeElement,trigger);assert.equal(trigger.getAttribute('aria-expanded'),'false');
 x.root.emit('keydown',{target:trigger,key:'Enter'});x.menu().querySelector('.reference-popover-close').emit('click');assert.equal(x.doc.activeElement,trigger);x.api.destroy();
});
test('opening a trailing formatted fragment restores focus to its accessible first fragment',()=>{
 const x=setup(),citation=x.api.forBlock('body','en')[0],first=x.fragment(citation,citation.start,citation.start+2),last=x.fragment(citation,citation.start+2,citation.end);
 assert.equal(last.getAttribute('aria-hidden'),'true');x.root.emit('click',{target:last});assert(x.api.isOpen());x.doc.emit('keydown',{key:'Escape'});assert.equal(x.doc.activeElement,first);x.api.destroy();
});
test('group target click navigates once and focused destination does not alter citation strings',()=>{
 const x=setup(),trigger=x.fragment(x.api.forBlock('body','en')[0]);x.root.emit('click',{target:trigger});const link=x.menu().querySelectorAll('[data-reference-target-number]')[2];x.menu().querySelector('.reference-popover-list').emit('click',{target:link});
 assert.deepEqual(x.navigations,['ref-3']);assert.equal(x.api.isOpen(),false);x.flush();assert.equal(x.doc.activeElement.id,'ref-3');assert.equal(trigger.textContent,'1–3,5');x.api.destroy();
});
test('pointerdown does not prevent native selection and pending span tabindex is restored on up or destroy',()=>{
 for(const end of ['up','destroy']){const x=setup(),trigger=x.fragment(x.api.forBlock('body','en')[0]);const e=x.root.emit('pointerdown',{target:trigger});assert.equal(e.defaultPrevented,false);assert.equal(trigger.getAttribute('tabindex'),null);if(end==='up')x.doc.emit('pointerup');else x.api.destroy();assert.equal(trigger.tabIndex,0);if(end==='up')x.api.destroy();assert.equal(x.root.count(),0);assert.equal(x.doc.count(),0);assert.equal(x.win.count(),0);}
});
test('modifier clicks retain native anchor semantics and popover stays outside occupied toolbar',()=>{
 const x=setup(),single=x.fragment(x.api.forBlock('body','en')[2]);const e=x.root.emit('click',{target:single,metaKey:true});assert.equal(e.defaultPrevented,false);assert.equal(x.navigations.length,0);
 const trigger=x.fragment(x.api.forBlock('body','en')[0]);Object.assign(trigger.rect,{top:150,bottom:170});x.root.emit('click',{target:trigger});assert.equal(x.menu().hidden,false);assert(Number.parseFloat(x.menu().style.top)>=144);x.doc.emit('pointerdown',{target:x.toolbar});assert.equal(x.api.isOpen(),false);x.api.destroy();
});
test('popup geometry flips above near bottom and clamps at narrow viewport edges',()=>{
 const p=refs.positionPopover({left:380,right:389,top:700,bottom:720},{width:300,height:220},{left:0,top:136,width:390,height:708});assert.equal(p.placement,'above');assert.equal(p.left,82);assert.equal(p.top,472);assert(p.top>=144&&p.top+220<=836);
});
