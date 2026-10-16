/* Structural/unit evidence only; no claim of browser layout or native-toggle testing. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createTree, render} = require('../assets/reader/toc.js');

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = [];
    this.parentElement = null; this.dataset = {}; this.attributes = new Map();
    this.className = ''; this.id = ''; this.open = false; this.listeners = new Map(); this._text = '';
  }
  get textContent() {return this._text + this.children.map(child => child.textContent).join('');}
  set textContent(value) {this.replaceChildren(); this._text = String(value);}
  append(...items) {for (const item of items) {item.remove(); item.parentElement = this; this.children.push(item);}}
  replaceChildren(...items) {this.children.forEach(child => {child.parentElement = null;}); this.children = []; this._text = ''; this.append(...items);}
  remove() {if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null;}
  setAttribute(key, value) {this.attributes.set(key, String(value));}
  getAttribute(key) {return this.attributes.get(key) ?? null;}
  removeAttribute(key) {this.attributes.delete(key);}
  addEventListener(type, handler) {const handlers = this.listeners.get(type) || []; handlers.push(handler); this.listeners.set(type, handlers);}
  removeEventListener(type, handler) {this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== handler));}
  dispatch(type, extra = {}) {
    const event = {button:0, defaultPrevented:false, preventDefault() {this.defaultPrevented = true;}, ...extra};
    (this.listeners.get(type) || []).forEach(handler => handler(event)); return event;
  }
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const tagged = (root, tag) => descendants(root).filter(child => child.tagName === tag.toUpperCase());
function dom() {const document = {createElement(tag) {return new Element(tag, document);}}; return document.createElement('nav');}
const block = (blockId, kind = 'body', en = 'Source body', zh = '原文正文') => ({blockId, kind, en, zh});
const section = (sectionId, blockIds, titleEn = 'Source section', titleZh = '原文章节') => ({sectionId, blockIds, titleEn, titleZh});
const paper = (sections, blocks, toc) => ({sections, blocks, ...(toc === undefined ? {} : {toc})});
const config = items => ({version:1, items});
const item = (id, targetId, titleEn = 'Source label', titleZh = '来源标签', children = []) => ({id, targetId, titleEn, titleZh, children});
const flat = items => items.flatMap(value => [value, ...flat(value.children)]);
function freezeDeep(value) {if (value && typeof value === 'object') {Object.values(value).forEach(freezeDeep); Object.freeze(value);} return value;}

test('fallback keeps canonical section order and excludes only actual caption/graphic-only sections', () => {
  const p = paper([
    section('source-A', ['a']), section('graphics', ['cap', 'graphic']),
    section('scientific-figure-topic', ['b'], 'Figure 4 mechanisms', '图 4 的机制'), section('tail', ['c'])
  ], [block('a'), block('cap', 'caption'), block('graphic', 'figure-label'), block('b'), block('c')]);
  assert.deepEqual(createTree(p).items.map(value => value.targetId), ['source-A', 'scientific-figure-topic', 'tail']);
});

test('fallback supports canonical block heading targets without inventing an umbrella', () => {
  const p = paper([section('science', ['a', 'h1', 'b', 'h2', 'c'], 'Methods', '方法')], [
    block('a'), block('h1', 'heading', ' Methods\n', '方法'), block('b'),
    block('h2', 'heading', 'Subsection\nwith source line wrap', '带原文换行的\n小节'), block('c')
  ]);
  const result = createTree(p);
  assert.equal(result.source, 'fallback'); assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].children.map(value => value.targetId), ['h2']);
  assert.equal(result.items[0].children[0].titleEn, p.blocks[3].en);
  assert.equal(flat(result.items).some(value => value.titleEn === 'Results'), false);
});

test('fallback compares only the first source heading and keeps later identical headings', () => {
  const p = paper([section('source', ['h1', 'h2', 'h3'], 'Methods', '方法')], [
    block('h1', 'heading', 'Different', '不同'), block('h2', 'heading', 'Methods', '方法'), block('h3', 'heading', 'Methods', '方法')
  ]);
  assert.deepEqual(createTree(p).items[0].children.map(value => value.targetId), ['h1', 'h2', 'h3']);
  p.blocks[0].en = 'Methods'; p.blocks[0].zh = '方法';
  assert.deepEqual(createTree(p).items[0].children.map(value => value.targetId), ['h2', 'h3']);
});

test('an explicit navigation group carries only source destinations and preserves exact labels', () => {
  const p = paper([section('source-one', ['h1']), section('source-two', ['h2'])], [block('h1', 'heading'), block('h2', 'heading')], config([
    {...item('group', 'source-one', 'Results', '结果', [item('first', 'h1', '<source & title>', '原文 <标题>'), item('second', 'source-two')]), role:'navigation-group', open:false}
  ]));
  const tree = createTree(p); assert.equal(tree.source, 'explicit'); assert.equal(tree.issues.length, 0);
  assert.equal(tree.items[0].role, 'navigation-group'); assert.equal(tree.items[0].open, false);
  assert.equal(tree.items[0].children[0].titleEn, '<source & title>');
  assert.deepEqual(flat(tree.items).map(value => value.targetId), ['source-one', 'h1', 'source-two']);
});

test('explicit caption targets and caption-only section targets are removed, ordinary content remains', () => {
  const p = paper([section('body', ['b']), section('legend-only', ['c'])], [block('b'), block('c', 'caption')], config([
    item('body-nav', 'body'), item('caption-nav', 'c'), item('caption-section-nav', 'legend-only'), item('unknown', 'missing')
  ]));
  const result = createTree(p); assert.deepEqual(flat(result.items).map(value => value.targetId), ['body']);
  assert.equal(result.issues.filter(value => value.code === 'excluded-or-missing-target').length, 3);
});

test('explicit navigation omissions preserve every non-caption section as a fallback entry', () => {
  const p = paper([section('listed', ['a']), section('unexpected-science', ['b']), section('legend', ['c'])], [block('a'), block('b'), block('c', 'caption')], config([item('one', 'listed')]));
  const result = createTree(p);
  assert.deepEqual(result.items.map(value => value.targetId), ['listed', 'unexpected-science']);
  assert.deepEqual(result.issues, [{code:'unlisted-section-preserved', sectionId:'unexpected-science'}]);
});

test('a partial block mapping preserves its section entry and every missing heading target', () => {
  const p = paper([section('methods-source', ['h1', 'body', 'h2'], 'Methods', '方法')], [
    block('h1', 'heading', 'Methods', '方法'), block('body'), block('h2', 'heading', 'Source subsection', '来源子节')
  ], config([item('partial-child', 'h1')]));
  const result = createTree(p), all = flat(result.items);
  assert.equal(result.items[0].targetId, 'methods-source');
  assert.equal(all.filter(value => value.targetId === 'h1').length, 1);
  assert.equal(all.filter(value => value.targetId === 'h2').length, 1);
  assert(result.issues.some(value => value.code === 'unlisted-section-preserved'));
});

test('fallback entries are inserted in canonical section order around an explicit later entry', () => {
  const p = paper([section('first', ['a']), section('second', ['b']), section('last', ['c'])], [block('a'), block('b'), block('c')], config([item('last-nav', 'last')]));
  assert.deepEqual(createTree(p).items.map(value => value.targetId), ['first', 'second', 'last']);
});

test('a complete explicit tree retains its authored navigation order', () => {
  const p = paper([section('first', ['a']), section('last', ['b'])], [block('a'), block('b')], config([item('last-nav', 'last'), item('first-nav', 'first')]));
  assert.deepEqual(createTree(p).items.map(value => value.targetId), ['last', 'first']);
});

test('discarding an invalid parent cannot discard its otherwise represented child section', () => {
  const p = paper([section('source', ['b'])], [block('b')], config([{children:[item('child', 'source')]}]));
  const result = createTree(p); assert.equal(result.items.length, 1); assert.equal(result.items[0].targetId, 'source');
  assert(result.issues.some(value => value.code === 'missing-label'));
  assert(result.issues.some(value => value.code === 'unlisted-section-preserved'));
});

test('explicit metadata is preferred over readerSettings, which is a supported fallback', () => {
  const p = paper([section('source', ['b'])], [block('b')]);
  p.readerSettings = {toc:config([item('settings', 'source')]), language:'zh'};
  assert.equal(createTree(p).items[0].id, 'settings');
  p.toc = config([item('top', 'source')]); assert.equal(createTree(p).items[0].id, 'top');
  p.toc = {version:7, items:[]}; assert.equal(createTree(p).source, 'fallback');
  assert(createTree(p).issues.some(value => value.code === 'invalid-configuration'));
});

test('cycles, duplicate IDs and invalid targets are contained without losing source access', () => {
  const cycle = item('cycle', 'source'); cycle.children.push(cycle);
  const p = paper([section('source', ['b'])], [block('b')], config([item('same', 'source'), item('same:1', 'source'), item('same', 'source'), cycle]));
  const result = createTree(p), ids = flat(result.items).map(value => value.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(result.issues.some(value => value.code === 'duplicate-item-id'));
  assert(result.issues.some(value => value.code === 'invalid-node'));
});

test('tree construction and rendering never mutate frozen canonical data or metadata', () => {
  const p = freezeDeep(paper([section('source', ['b'])], [block('b')], config([{
    ...item('source-nav', 'source'), sourceBlockIds:['b'], evidence:'Verified original heading'
  }])));
  const before = JSON.stringify(p), root = dom(); const controller = render(root, p, () => {});
  assert.equal(JSON.stringify(p), before); assert.deepEqual(controller.tree[0].sourceBlockIds, ['b']);
  controller.tree[0].sourceBlockIds.push('copy-only'); assert.equal(p.toc.items[0].sourceBlockIds.length, 1);
});

test('rendered groups use semantic native details/summary and both language labels in every mode', () => {
  for (const language of ['en', 'zh', 'both']) {
    const p = paper([section('source', ['b'])], [block('b')], config([{...item('group', 'source', 'Parent', '父级', [item('child', 'b', 'Child <&>', '子节 <&>')]), role:'navigation-group'}]));
    p.readerSettings = {language}; const root = dom(); const controller = render(root, p, () => {});
    assert.equal(root.getAttribute('role'), 'navigation'); assert.equal(root.getAttribute('aria-label'), 'Article contents / 文章目录');
    const groups = tagged(root, 'details'); assert.equal(groups.length, 1); assert.equal(groups[0].children[0].tagName, 'SUMMARY');
    assert.equal(groups[0].open, false); assert.equal(tagged(root, 'a').length, 2);
    for (const anchor of tagged(root, 'a')) {assert.equal(anchor.children.length, 2); assert.deepEqual(anchor.children.map(value => value.lang), ['en', 'zh-Hans']);}
    assert.equal(root.textContent, 'Parent父级Child <&>子节 <&>');
    assert(descendants(root).every(value => value.id === ''), 'canonical IDs are not cloned into navigation');
    controller.expandAll(); assert.equal(groups[0].open, true); controller.collapseAll(); assert.equal(groups[0].open, false);
  }
});

test('targetless navigation groups remain foldable and source links invoke the callback', () => {
  const p = paper([section('source/path:odd', ['b'])], [block('b')], config([{id:'group', titleEn:'Group', titleZh:'组', children:[item('child', 'source/path:odd')]}]));
  const root = dom(), calls = []; render(root, p, (id, context) => calls.push({id, context}));
  assert.equal(tagged(root, 'summary')[0].children[0].tagName, 'SPAN');
  const link = tagged(root, 'a')[0]; assert.equal(link.href, '#source%2Fpath%3Aodd');
  const click = link.dispatch('click'); assert.equal(click.defaultPrevented, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'source/path:odd'); assert.equal(calls[0].context.anchor, link);
  assert.equal(calls[0].context.item.id, 'child');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) assert.equal(link.dispatch('click', {[modifier]:true}).defaultPrevented, false);
  assert.equal(link.dispatch('click', {button:1}).defaultPrevented, false); assert.equal(calls.length, 1);
});

test('explicit open state overrides defaultOpen and all groups can be controlled', () => {
  const p = paper([section('source', ['b'])], [block('b')], config([
    {...item('closed', 'source', 'Closed', '收拢', [item('child', 'b')]), open:false},
    {...item('opened', 'source', 'Opened', '展开', [item('other-child', 'b')]), open:true}
  ]));
  const root = dom(); render(root, p, () => {}, {defaultOpen:true});
  assert.deepEqual(tagged(root, 'details').map(value => value.open), [false, true]);
});

test('rerender and destroy remove listeners and restore preexisting root semantics', () => {
  const p = paper([section('source', ['b'])], [block('b')]); const root = dom(); root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'Original label');
  let clicks = 0; const first = render(root, p, () => {clicks++;}), old = tagged(root, 'a')[0];
  const second = render(root, p, () => {clicks++;}); assert.equal(root.children.length, 1);
  old.dispatch('click'); assert.equal(clicks, 0); tagged(root, 'a')[0].dispatch('click'); assert.equal(clicks, 1);
  first.destroy(); assert.equal(root.children.length, 1, 'old controller cannot destroy newer tree');
  second.destroy(); second.destroy(); assert.equal(root.children.length, 0);
  assert.equal(root.getAttribute('role'), 'region'); assert.equal(root.getAttribute('aria-label'), 'Original label');
});

test('empty input renders an empty accessible navigation and invalid root fails explicitly', () => {
  const root = dom(), result = render(root, {}, undefined); assert.equal(result.tree.length, 0);
  assert.equal(root.children[0].tagName, 'UL'); result.destroy(); assert.equal(root.getAttribute('role'), null);
  assert.throws(() => render(null, {}), /TOC root element required/);
});
