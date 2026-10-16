'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const font = require('../assets/reader/reading-font.js');

function harness({stored, storageError, deniedAccess, paper, anchor = false, caret = false} = {}) {
  const values = new Map(), writes = [], callbacks = [], errors = [], scrolls = [];
  const handlers = new Map();
  const button = name => ({name, disabled:false, attrs:{},
    setAttribute(k,v) {this.attrs[k]=v;},
    addEventListener(k,fn) {handlers.set(name+':'+k, fn);},
    removeEventListener(k) {handlers.delete(name+':'+k);}});
  const decrease = button('decrease'), increase = button('increase'), status = {textContent:''};
  const storage = {getItem() {if(storageError === 'read') throw Error('read denied'); return stored ?? null;},
    setItem(key,value) {if(storageError === 'write') throw Error('quota'); writes.push([key,value]);}};
  let currentTop = 80, characterTop = 90;
  const textNode = {nodeType:3,length:100,isConnected:true};
  const range = {startContainer:textNode,startOffset:10,
    setStart(node,offset) {this.startContainer=node; this.startOffset=offset;},
    setEnd() {}, getClientRects:() => [1], getBoundingClientRect:() => ({top:characterTop})};
  const prose = {isConnected:true,
    contains:node => node === textNode,
    getClientRects:() => [1],
    getBoundingClientRect:() => ({top:currentTop,bottom:currentTop+300,height:300,left:20,right:500,width:480})};
  const article = {getClientRects:() => anchor ? [1] : [], querySelectorAll:() => [prose]};
  const win = {innerHeight:700, scrollBy(options) {scrolls.push(options); callbacks.push('scroll'); currentTop-=options.top; characterTop-=options.top;}};
  Object.defineProperty(win, 'localStorage', {get() {if(deniedAccess) throw Error('denied'); return storage;}});
  const doc = {defaultView:win, documentElement:{clientHeight:700,style:{
    setProperty(key,value) {const before=values.get(key); values.set(key,value); if(anchor && before && before !== value) {if(caret) characterTop+=55; else currentTop+=55;}}}},
    querySelector:() => null};
  if(caret) doc.caretRangeFromPoint=() => range;
  const toolbar = {getBoundingClientRect:() => ({bottom:60})};
  const reader = font.create({document:doc,paper:paper || {documentId:'article',sourceSha256:'source'},
    decreaseButton:decrease,increaseButton:increase,status,article,toolbar,
    measureToolbar:() => callbacks.push('measure'),refreshImages:() => callbacks.push('images'),
    queueFollow:() => callbacks.push('follow'),onStorageError:error => errors.push(error.message)});
  return {reader, values, writes, callbacks, errors, decrease, increase, status, handlers, scrolls};
}

test('size steps are integer, bounded and safe for invalid persisted values', () => {
  assert.equal(font.DEFAULT_SIZE,18);
  assert.equal(font.nextSize(18,1),19);
  assert.equal(font.nextSize(18,-1),17);
  assert.equal(font.nextSize(26,1),26);
  assert.equal(font.nextSize(14,-1),14);
  assert.equal(font.normalizeSize(19.6),20);
  assert.equal(font.normalizeSize(NaN),18);
  for(const value of [null,'18',NaN,Infinity,{},[]]) assert.equal(font.normalizeSize(value,20),20);
  assert.equal(font.readStoredSize('{"schemaVersion":1,"fontSize":24}'),24);
  for(const raw of ['broken','null','{"schemaVersion":2,"fontSize":24}',
    '{"schemaVersion":1,"fontSize":100}','{"schemaVersion":1,"fontSize":"20"}',
    '{"schemaVersion":1,"fontSize":18.5}']) assert.equal(font.readStoredSize(raw,19),19);
});

test('article identity combines document id and source hash without punctuation collisions', () => {
  const key = font.preferenceKey({documentId:'a:b',sourceSha256:'c'});
  assert.equal(key,'micro-paper:reading-font:v1:["a:b","c"]');
  assert.notEqual(key,font.preferenceKey({documentId:'a',sourceSha256:'b:c'}));
  assert.notEqual(key,font.preferenceKey({documentId:'a:b',sourceSha256:'new-source'}));
  assert.notEqual(key,font.preferenceKey({documentId:'other',sourceSha256:'c'}));
  assert.equal(font.preferenceKey({documentId:'a'}),null);
});

test('initialization restores only this article preference and does not write storage', () => {
  const h=harness({stored:'{"schemaVersion":1,"fontSize":22}'});
  assert.equal(h.reader.getSize(),22);
  assert.equal(h.values.get('--reading-font-size'),'22px');
  assert.equal(h.writes.length,0);
  assert.deepEqual(h.reader.getSettings(),{readingFontSize:22});
  assert.equal(h.status.textContent,'正文及图注字号：22px');
  const exported=harness({paper:{documentId:'x',sourceSha256:'y',readerSettings:{readingFontSize:20}}});
  assert.equal(exported.reader.getSize(),20);
});

test('buttons change body size, serialize a separate key and stop at both limits', () => {
  const h=harness();
  h.handlers.get('increase:click')();
  assert.equal(h.reader.getSize(),19);
  assert.deepEqual(h.writes,[['micro-paper:reading-font:v1:["article","source"]','{"schemaVersion":1,"fontSize":19}']]);
  assert(h.callbacks.includes('images') && h.callbacks.includes('measure') && h.callbacks.includes('follow'));
  h.reader.setSize(100);
  assert.equal(h.reader.getSize(),26); assert.equal(h.increase.disabled,true); assert.equal(h.decrease.disabled,false);
  h.reader.step(1); assert.equal(h.reader.getSize(),26);
  h.reader.setSize(0);
  assert.equal(h.reader.getSize(),14); assert.equal(h.decrease.disabled,true); assert.equal(h.increase.disabled,false);
  assert.match(h.decrease.attrs['aria-label'],/14/);
  const count=h.writes.length;
  h.reader.step(-1); assert.equal(h.writes.length,count);
  h.reader.destroy(); assert.equal(h.handlers.size,0);
  h.reader.setSize(18); assert.equal(h.reader.getSize(),14);
});

test('preference access and quota failures leave controls usable and cannot access notes', () => {
  for(const failure of [{deniedAccess:true},{storageError:'read'},{storageError:'write'}]) {
    const h=harness(failure);
    h.reader.step(1); h.reader.step(1);
    assert.equal(h.reader.getSize(),20);
    assert.equal(h.values.get('--reading-font-size'),'20px');
    assert.equal(h.errors.length,1);
    assert(h.writes.every(([key]) => key.startsWith('micro-paper:reading-font:')));
  }
});

test('size reflow preserves the visible reading paragraph before follow callbacks run', () => {
  const h=harness({anchor:true});
  h.reader.step(1);
  assert.deepEqual(h.scrolls,[{top:55,left:0,behavior:'instant'}]);
  assert(h.callbacks.indexOf('scroll') < h.callbacks.indexOf('follow'));
  assert.equal(h.values.size,1);
  h.reader.setSize(20,{preserveAnchor:false,persist:false});
  assert.equal(h.scrolls.length,1);
  assert.equal(h.writes.length,1);
});

test('character anchor compensates line reflow inside a paragraph whose top did not move', () => {
  const h=harness({anchor:true,caret:true});
  h.reader.step(1);
  assert.deepEqual(h.scrolls,[{top:55,left:0,behavior:'instant'}]);
});
