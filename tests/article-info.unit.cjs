/* Structural regression with a small DOM stub; this is not browser/CSS evidence. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
const unescapeCss = text => text.replace(/\\(.)/g, '$1');
class TextNode {
  constructor(text, ownerDocument) { this.nodeType = 3; this.textContent = String(text); this.ownerDocument = ownerDocument; this.parentNode = null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
}
class Element {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1; this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument;
    this.childNodes = []; this.parentNode = null; this.dataset = {}; this.attributes = new Map();
    this.className = ''; this.id = ''; this.style = {}; this.open = false; this.hidden = false;
    this.listeners = new Map();
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? 'add' : 'remove'](name); return on; }
    };
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get previousElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) - 1] || null; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== '') this.append(new TextNode(value, this.ownerDocument)); }
  append(...items) {
    for (let item of items) {
      if (typeof item === 'string' || typeof item === 'number') item = new TextNode(item, this.ownerDocument);
      if (item.nodeType === 11) { this.append(...item.childNodes); continue; }
      item.remove?.(); item.parentNode = this; this.childNodes.push(item);
    }
  }
  appendChild(item) { this.append(item); return item; }
  prepend(...items) { const old = [...this.childNodes]; this.replaceChildren(...items, ...old); }
  replaceChildren(...items) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...items); }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
    if (name === 'open') this.open = true;
  }
  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null;
    if (name === 'open') return this.open ? '' : null;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { this.attributes.delete(name); if (name.startsWith('data-')) delete this.dataset[dataKey(name)]; if (name === 'open') this.open = false; }
  matches(selector) { return selector.split(',').some(part => matchesComplex(this, part.trim())); }
  closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = parent => { for (const child of parent.children) { if (child.matches(selector)) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(other) { return other === this || this.childNodes.some(child => child === other || child.contains?.(other)); }
  addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); }
  click() { this.onclick?.({target:this}); for (const handler of this.listeners.get('click') || []) handler({target:this}); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.didScroll = true; }
}
function matchesSimple(element, selector) {
  const attrs = [];
  selector = selector.replace(/\[([^\]=\s]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, name, double, single, raw) => { attrs.push([name, double ?? single ?? raw]); return ''; });
  for (const [name, value] of attrs) if (value === undefined ? !element.hasAttribute(name) : element.getAttribute(name) !== unescapeCss(value.trim())) return false;
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  for (const match of selector.matchAll(/([.#])((?:\\.|[\w:-])+)/g)) {
    const value = unescapeCss(match[2]);
    if (match[1] === '#' ? element.id !== value : !element.classList.contains(value)) return false;
  }
  return true;
}
function matchesComplex(element, selector) {
  const parts = selector.match(/(?:\[[^\]]*\]|[^\s])+|\s+/g)?.filter(part => part.trim()).map(part => part.trim()) || [];
  const current = parts.pop(); if (!current || !matchesSimple(element, current)) return false;
  let ancestor = element.parentElement;
  while (parts.length) { const required = parts.pop(); while (ancestor && !matchesSimple(ancestor, required)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
  return true;
}
function createDocument() {
  const document = {
    createElement(tag) { return new Element(tag, document); },
    createTextNode(text) { return new TextNode(text, document); },
    createDocumentFragment() { const fragment = new Element('fragment', document); fragment.nodeType = 11; return fragment; }
  };
  document.body = document.createElement('body');
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getElementById = id => document.body.querySelectorAll('[id]').find(element => element.id === id) || null;
  return document;
}

const {createArticleInfo} = require('../assets/reader/article-info.js');
const block = (blockId, en, zh = en, extra = {}) => ({blockId, kind:'body', en, zh, sourceSpans:[{pageId:'source-page'}], ...extra});
const section = (sectionId, blockIds = [], extra = {}) => ({sectionId, titleEn:'Custom source information', titleZh:'自定义来源信息', blockIds, ...extra});
const makePaper = (sections, blocks, articleInfo, metadata = {}) => ({
  documentId:'article-info-unit', metadata:{titleEn:'Scientific title', titleZh:'科学标题', authors:['FALLBACK AUTHOR ONLY'], doi:'10.5678/fallback-only', ...metadata},
  sections, blocks, ...(articleInfo ? {articleInfo} : {})
});
function createHarness(paper, decorate) {
  const document = createDocument(); global.document = document;
  const calls = {text:[], source:[], clicked:[]};
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const blocksById = new Map(paper.blocks.map(item => [item.blockId, item]));
  const renderText = (source, language, interactive, suppressedRanges = []) => { const prose = node('p', source[language], 'prose'); prose.dataset.blockId = source.blockId; prose.dataset.language = language; decorate?.(source, language, prose, node); calls.text.push({source, language, prose, suppressedRanges}); return prose; };
  const sourceButton = source => { calls.source.push(source); const button = node('button', 'Source page', 'source-link'); button.dataset.sourceFor = source.blockId; button.onclick = () => calls.clicked.push(source.blockId); return button; };
  const info = createArticleInfo({paper, node, renderText, blocksById, sourceButton});
  return {...info, document, calls, blocksById, mount(...nodes) { document.body.replaceChildren(...nodes); return document.body; }};
}
const canonicalBlocks = root => root.querySelectorAll('.block[data-block-id]');
const findBlock = (root, id) => canonicalBlocks(root).find(element => element.dataset.blockId === id);
const field = (root, key) => root.querySelectorAll('[data-info-field]').find(element => element.dataset.infoField === key);
function assertCanonical(root, source, duplicate = false) {
  const matches = canonicalBlocks(root).filter(element => element.dataset.blockId === source.blockId);
  assert.equal(matches.length, 1, `one canonical source wrapper for ${source.blockId}`);
  const wrapper = matches[0]; assert.equal(wrapper.id, source.blockId);
  for (const language of ['en', 'zh']) {
    const prose = wrapper.querySelectorAll('.prose').filter(element => element.dataset.language === language);
    assert.equal(prose.length, 1, `${source.blockId}: ${language} remains in the canonical DOM`);
    assert.equal(prose[0].dataset.blockId, source.blockId);
    assert.equal(prose[0].textContent, source[language], `${source.blockId}: ${language} exact canonical text`);
    if (language === 'zh') assert.equal(prose[0].dataset.duplicate === 'true', duplicate);
  }
  assert.equal(wrapper.querySelectorAll('.source-link').length, 1);
  assert.equal(wrapper.querySelector('.source-link').dataset.sourceFor, source.blockId);
  return wrapper;
}
function assertFieldStructure(row) {
  assert(row, 'configured field row exists');
  const label = row.querySelector('.info-label'), value = row.querySelector('.info-value');
  assert(label && value); assert.equal(label.nextElementSibling, value, 'field label and value are adjacent');
  assert(label.textContent.trim(), 'field label is visible text');
}
function assertSourceCalls(actual, expected) {
  assert.equal(actual.length, expected.length, 'source callback runs once for each canonical block');
  for (const source of expected) assert.equal(actual.filter(value => value === source).length, 1, `original source object forwarded once: ${source.blockId}`);
}
function explicitFixture() {
  const authors = block('identity:odd.17', 'Amélie Martin¹, Sami Chen², ' + 'Researcher 𝛼, '.repeat(24), 'Amélie Martin¹、Sami Chen²；' + '研究者 α，'.repeat(24));
  const affil1 = block('institution/x-21', 'Department of Biology\nUniversity A <West> & Centre', '生物系\nA 大学 <西区> & 中心');
  const affil2 = block('institution/x-22', 'Institute of Quantitative Science; ' + 'Long institutional description. '.repeat(15), '定量科学研究所；' + '机构完整说明。'.repeat(30));
  const doi1 = block('publisher.value.31', 'https://doi.org/10.9999/source', 'https://doi.org/10.9999/source');
  const doi2 = block('publisher.value.94', 'https://doi.org/10.9999/source', 'https://doi.org/10.9999/source');
  const contact = block('contact/value', 'Correspondence: science@example.org', '通讯：science@example.org');
  const unknown = block('custom/information', 'Registered research statement & identifiers', '登记的研究说明与标识符');
  const science = block('authors', 'Article information does not change the assay: n = 7; α < 0.05.\nAll observations remain.', '文章信息不改变该检测：n = 7；α < 0.05。\n保留全部观察结果。', {kind:'methods'});
  const ordinary = block('ordinary.science', 'Scientific results', '科学结果');
  const first = section('not-a-known-frontmatter-id', [authors.blockId, affil1.blockId, affil2.blockId, doi1.blockId, science.blockId, unknown.blockId]);
  const second = section('another/arbitrary.id', [doi2.blockId, contact.blockId]);
  const normal = section('methods', [ordinary.blockId], {titleEn:'Methods', titleZh:'方法'});
  const fields = [
    {key:'authors', labelEn:'Contributors', labelZh:'署名作者', blockIds:[authors.blockId], collapsed:true},
    {key:'affiliations', labelEn:'Institutions', labelZh:'所属机构', blockIds:[affil1.blockId, affil2.blockId], collapsed:true},
    {key:'doi', labelEn:'Persistent identifier', labelZh:'永久标识', blockIds:[doi1.blockId, doi2.blockId]},
    {key:'correspondence', labelEn:'Contact', labelZh:'联系信息', blockIds:[contact.blockId]},
    {key:'custom-research-field', labelEn:'Registered information', labelZh:'登记信息', blockIds:[unknown.blockId]}
  ];
  const blocks = [authors, affil1, affil2, doi1, doi2, contact, unknown, science, ordinary];
  return {paper:makePaper([first, second, normal], blocks, {sectionIds:[first.sectionId, second.sectionId], fields}), first, second, normal, authors, affil1, affil2, doi1, doi2, contact, unknown, science};
}

test('explicit section and field IDs route arbitrary source blocks into stable information rows', () => {
  const f = explicitFixture(), before = structuredClone(f.paper), h = createHarness(f.paper);
  const first = h.render(f.first, 'both'), second = h.render(f.second, 'both');
  assert(first.matches('.article-info')); assert.equal(first.dataset.role, 'article-info'); assert.equal(first.id, f.first.sectionId);
  assert(second.matches('.article-info')); assert.equal(second.dataset.role, 'article-info'); assert.equal(second.id, f.second.sectionId);
  for (const key of ['authors', 'affiliations', 'doi', 'custom-research-field']) assertFieldStructure(field(first, key));
  for (const key of ['doi', 'correspondence']) assertFieldStructure(field(second, key));
  assert.equal(field(first, 'correspondence'), undefined); assert.equal(field(second, 'authors'), undefined);
  for (const source of f.paper.blocks.filter(item => item !== f.paper.blocks.at(-1))) {
    const root = f.first.blockIds.includes(source.blockId) ? first : second;
    assertCanonical(root, source, source.en === source.zh);
    assert.equal(findBlock(root, source.blockId).closest('[data-info-field]')?.dataset.infoField, source === f.science ? undefined : source === f.unknown ? 'custom-research-field' : source === f.authors ? 'authors' : [f.affil1, f.affil2].includes(source) ? 'affiliations' : source === f.contact ? 'correspondence' : 'doi');
  }
  assertSourceCalls(h.calls.source, f.paper.blocks.filter(item => item !== f.paper.blocks.at(-1)));
  assert.equal(h.calls.text.length, h.calls.source.length * 2);
  assert(h.calls.text.every(call => call.source === h.blocksById.get(call.source.blockId)));
  for (const call of h.calls.text) assert([first, second].some(root => root.contains(call.prose)), 'canonical renderText DOM is appended intact');
  for (const button of [...first.querySelectorAll('.source-link'), ...second.querySelectorAll('.source-link')]) button.click();
  assert.deepEqual(h.calls.clicked.toSorted(), h.calls.source.map(item => item.blockId).toSorted());
  assert(!first.textContent.includes('FALLBACK AUTHOR ONLY')); assert(!first.textContent.includes('10.5678/fallback-only'));
  assert.deepEqual(f.paper, before, 'rendering does not rewrite paper data');
});

test('long authors and affiliations remain fully expanded despite old collapsed hints', () => {
  const f = explicitFixture(), h = createHarness(f.paper), root = h.render(f.first, 'both');
  for (const key of ['authors', 'affiliations']) {
    const row = field(root, key);
    assertFieldStructure(row); assert.equal(row.tagName, 'DIV');
    assert.equal(row.querySelector('details'), null); assert.equal(row.querySelector('summary'), null);
    for (const id of f.paper.articleInfo.fields.find(item => item.key === key).blockIds) {
      const wrapper = findBlock(root, id);
      assert(row.querySelector('.info-value').contains(wrapper));
      assert.equal(wrapper.closest('details'), null);
    }
  }
  assertCanonical(root, f.authors); assertCanonical(root, f.affil1); assertCanonical(root, f.affil2);
});

test('long semantic fields stay expanded by default and configured EN/ZH labels remain exact text', () => {
  const f = explicitFixture();
  f.paper.articleInfo.fields = f.paper.articleInfo.fields.map(({collapsed, ...rest}) => rest);
  const h = createHarness(f.paper);
  for (const language of ['en', 'zh']) {
    const root = h.render(f.first, language);
    for (const key of ['authors', 'affiliations']) {
      const row = field(root, key);
      const config = f.paper.articleInfo.fields.find(item => item.key === key);
      assert.equal(row.querySelector('details'), null, `${key} never defaults to folding`);
      assert.equal(row.querySelector('.info-label').textContent, config[language === 'en' ? 'labelEn' : 'labelZh']);
    }
  }
});

test('both language mode marks only exactly equal Chinese prose; single modes retain both canonical strings', () => {
  const equal = block('equal/𝛼', 'A\n<B> & C\u00a0𝛼¹', 'A\n<B> & C\u00a0𝛼¹');
  const almost = block('not-equal', 'Author A ', 'Author A');
  const front = section('manual-language-section', [equal.blockId, almost.blockId]);
  const paper = makePaper([front], [equal, almost], {sectionIds:[front.sectionId], fields:[{key:'authors', labelEn:'Authors', labelZh:'作者', blockIds:[equal.blockId, almost.blockId]}]});
  const before = structuredClone(paper), h = createHarness(paper);
  for (const language of ['both', 'en', 'zh', 'both']) {
    const sourceCount = h.calls.source.length, textCount = h.calls.text.length;
    const root = h.render(front, language);
    assertCanonical(root, equal, language === 'both'); assertCanonical(root, almost, false);
    if (language !== 'both') for (const prose of root.querySelectorAll('.prose')) assert.equal(prose.hidden, false, 'language switching keeps canonical prose in the DOM');
    assertSourceCalls(h.calls.source.slice(sourceCount), [equal, almost]);
    assert.equal(h.calls.text.length - textCount, 4);
  }
  assert.deepEqual(paper, before);
});

test('overlapping field IDs belong only to the first configured field and never clone canonical anchors', () => {
  const shared = block('shared/info', 'Shared source', '共享来源'), extra = block('second-only', 'Second source', '第二来源');
  const front = section('overlap', [shared.blockId, shared.blockId, extra.blockId, 'missing-section-block']);
  const paper = makePaper([front], [shared, extra], {sectionIds:[front.sectionId], fields:[
    {key:'first', labelEn:'First', labelZh:'第一项', blockIds:[shared.blockId, shared.blockId]},
    {key:'second', labelEn:'Second', labelZh:'第二项', blockIds:[shared.blockId, extra.blockId, 'missing-block']}
  ]});
  const h = createHarness(paper), root = h.render(front, 'both');
  assertCanonical(root, shared); assertCanonical(root, extra);
  assert.equal(findBlock(root, shared.blockId).closest('[data-info-field]').dataset.infoField, 'first');
  assert.equal(findBlock(root, extra.blockId).closest('[data-info-field]').dataset.infoField, 'second');
  assert.deepEqual(h.calls.source, [shared, extra]);
  assert.equal(canonicalBlocks(root).length, 2);
});

test('unmapped scientific blocks and unknown configured source fields are preserved safely', () => {
  const source = block('odd-key', '<script>source text</script> & values', '来源文字 <img> & 数值');
  const science = block('doi-authors-affiliation', 'Methods: DOI signals were analyzed; authors are not a metadata field.', '方法：分析 DOI 信号；作者并不是元数据字段。', {kind:'methods'});
  const front = section('safe-fields', [source.blockId, science.blockId]);
  const paper = makePaper([front], [source, science], {sectionIds:[front.sectionId], fields:[{key:'constructor', labelEn:'<Unknown field>', labelZh:'<未知字段>', blockIds:[source.blockId, 'absent']} ]});
  const h = createHarness(paper), root = h.render(front, 'both');
  assertFieldStructure(field(root, 'constructor')); assertCanonical(root, source); assertCanonical(root, science);
  assert.equal(findBlock(root, science.blockId).closest('[data-info-field]'), null);
  assert.equal(root.querySelector('script'), null); assert.equal(root.querySelector('img'), null);
  assert.equal(canonicalBlocks(root).length, 2);
});

test('prototype-like custom field names without configured labels get safe textual defaults', () => {
  const constructor = block('source-constructor', 'First unknown source field', '第一个未知来源字段');
  const proto = block('source-proto', 'Second unknown source field', '第二个未知来源字段');
  const front = section('custom-default-labels', [constructor.blockId, proto.blockId]);
  const paper = makePaper([front], [constructor, proto], {sectionIds:[front.sectionId], fields:[
    {key:'constructor', blockIds:[constructor.blockId]}, {key:'__proto__', blockIds:[proto.blockId]}
  ]});
  const h = createHarness(paper), root = h.render(front, 'both');
  for (const key of ['constructor', '__proto__']) { assertFieldStructure(field(root, key)); assert.equal(field(root, key).querySelector('.info-label').textContent, key); }
  assertCanonical(root, constructor); assertCanonical(root, proto);
});

test('ordinary Article/scientific sections return null while explicitly recognized empty sections remain safe', () => {
  const normal = section('Article', [], {titleEn:'Article', titleZh:'文章'});
  const science = section('assay', ['science'], {titleEn:'Article information in the assay', titleZh:'实验中的文章信息'});
  const empty = section('empty', [], {titleEn:'Article information', titleZh:'文章信息'});
  const paper = makePaper([normal, science, empty], [block('science', 'Scientific paragraph', '科学段落')], undefined, {authors:[], doi:''});
  const h = createHarness(paper);
  assert.equal(h.render(normal, 'both'), null); assert.equal(h.render(science, 'both'), null);
  const root = h.render(empty, 'both'); assert(root.matches('.article-info')); assert.equal(canonicalBlocks(root).length, 0);
  assert.equal(h.render(undefined, 'both'), null); assert.equal(h.calls.text.length, 0); assert.equal(h.calls.source.length, 0);
});

test('metadata-only fallback uses textual author/DOI rows without fake canonical IDs or source links', () => {
  const front = section('fallback-custom-id', [], {titleEn:'Article information', titleZh:'文章信息'});
  const paper = makePaper([front], [], undefined, {authors:['Author Alpha', 'Author Beta'], doi:'10.1234/metadata'});
  const before = structuredClone(paper), h = createHarness(paper), root = h.render(front, 'both');
  for (const key of ['authors', 'doi']) assertFieldStructure(field(root, key));
  assert(field(root, 'authors').querySelector('.info-value').textContent.includes('Author Alpha'));
  assert(field(root, 'authors').querySelector('.info-value').textContent.includes('Author Beta'));
  assert.equal(root.textContent.split('10.1234/metadata').length - 1, 1);
  assert.equal(canonicalBlocks(root).length, 0); assert.equal(root.querySelectorAll('.prose').length, 0);
  assert.equal(root.querySelectorAll('[data-block-id]').length, 0); assert.equal(root.querySelectorAll('.source-link').length, 0);
  assert.equal(h.calls.text.length, 0); assert.equal(h.calls.source.length, 0); assert.deepEqual(paper, before);
});

test('multiple empty information sections display each metadata fallback only once', () => {
  const first = section('first-info', [], {titleEn:'Article information', titleZh:'文章信息'});
  const second = section('second-info', [], {titleEn:'Article info', titleZh:'文献信息'});
  const paper = makePaper([first, second], [], undefined, {authors:['Single fallback author'], doi:'10.8642/single-fallback'});
  const h = createHarness(paper), root = h.mount(h.render(first, 'both'), h.render(second, 'both'));
  assert.equal(root.querySelectorAll('[data-info-field]').filter(row => row.dataset.infoField === 'authors').length, 1);
  assert.equal(root.querySelectorAll('[data-info-field]').filter(row => row.dataset.infoField === 'doi').length, 1);
  assert.equal(root.textContent.split('Single fallback author').length - 1, 1);
  assert.equal(root.textContent.split('10.8642/single-fallback').length - 1, 1);
  assert.equal(canonicalBlocks(root).length, 0);
});

test('semantic source fields suppress metadata fallback across all recognized information sections', () => {
  const first = section('metadata-leading', [], {titleEn:'Front matter', titleZh:'文献信息'});
  const authors = block('unrelated-42', 'Source author list', '原始作者名单', {infoField:'authors'});
  const doi = block('unrelated-59', '10.2468/semantic-source', '10.2468/semantic-source', {kind:'doi'});
  const second = section('semantic-trailing', [authors.blockId, doi.blockId], {titleEn:'Article info', titleZh:'论文信息'});
  const paper = makePaper([first, second], [authors, doi], undefined, {authors:['METADATA AUTHOR MUST NOT APPEAR'], doi:'10.2468/semantic-source'});
  const h = createHarness(paper), roots = [h.render(first, 'both'), h.render(second, 'both')], root = h.mount(...roots);
  assertCanonical(root, authors); assertCanonical(root, doi, true);
  assert(!root.textContent.includes('METADATA AUTHOR MUST NOT APPEAR'));
  assert.equal(root.textContent.split('10.2468/semantic-source').length - 1, 2, 'only the two canonical language strings remain');
  assert.deepEqual(h.calls.source, [authors, doi]);
});

test('metadata-kind pure DOI values use arbitrary source IDs and retain repeated canonical source copies', () => {
  const doi1 = block('random-318', 'https://doi.org/10.1357/pure-value', 'https://doi.org/10.1357/pure-value', {kind:'metadata'});
  const doi2 = block('random-927', '10.1357/pure-value', '10.1357/pure-value', {kind:'metadata'});
  const front = section('value-detection', [doi1.blockId, doi2.blockId], {titleEn:'Article information', titleZh:'文章信息'});
  const paper = makePaper([front], [doi1, doi2], undefined, {authors:[], doi:'10.1357/pure-value'});
  const h = createHarness(paper), root = h.render(front, 'both');
  assertFieldStructure(field(root, 'doi')); assertCanonical(root, doi1, true); assertCanonical(root, doi2, true);
  assert.equal(root.textContent.split('10.1357/pure-value').length - 1, 4, 'no extra metadata DOI copy');
  assert.deepEqual(h.calls.source, [doi1, doi2]);
});

test('body-kind pure DOI source stays an ordinary canonical block while suppressing redundant metadata fallback', () => {
  const source = block('scientific/doi-only', '10.5319/body-source', '10.5319/body-source');
  const front = section('body-doi-info', [source.blockId], {titleEn:'Article information', titleZh:'文章信息'});
  const paper = makePaper([front], [source], undefined, {authors:[], doi:'10.5319/body-source'});
  const h = createHarness(paper), root = h.render(front, 'both');
  assertCanonical(root, source, true);
  assert.equal(findBlock(root, source.blockId).closest('[data-info-field]'), null);
  assert.equal(field(root, 'doi'), undefined);
  assert.equal(root.textContent.split('10.5319/body-source').length - 1, 2);
  assertSourceCalls(h.calls.source, [source]);
});

test('revealBlock returns visible canonical table nodes after language rerender or null', () => {
  const f = explicitFixture(), h = createHarness(f.paper), roots = [h.render(f.first, 'both'), h.render(f.second, 'both')];
  const root = h.mount(...roots), authors = findBlock(root, f.authors.blockId);
  assert.equal(authors.closest('details'), null);
  assert.equal(h.revealBlock(f.authors.blockId, root), authors);
  assert.equal(h.revealBlock(f.authors.blockId), authors);
  const rerendered = h.render(f.first, 'zh');
  const latest = findBlock(rerendered, f.authors.blockId);
  assert.equal(latest.closest('details'), null);
  assert.equal(h.revealBlock(f.authors.blockId), latest, 'latest language rendering supplies the canonical anchor');
  assert.equal(h.revealBlock(f.contact.blockId, root), findBlock(root, f.contact.blockId));
  assert.equal(h.revealBlock('not-a-source-block', root), null);
  const isolated = h.document.createElement('div'); assert.equal(h.revealBlock(f.authors.blockId, isolated), null);
});

// The DOM stub records the canonical-renderer mask contract; real visibility is tested by layout.cjs.
test('same DOI with different bilingual descriptions suppresses only its ZH token in both mode', () => {
  const b = block('different-doi-explanations','https://doi.org/10.1234/a.b (test only)','10.1234/a.b（仅作测试）');
  const sec = section('source-info',[b.blockId]);
  const p = makePaper([sec],[b],{sectionIds:[sec.sectionId],fields:[{key:'doi',labelEn:'DOI',labelZh:'DOI',blockIds:[b.blockId]}]},{doi:'10.1234/a.b'});
  const h = createHarness(p), root = h.render(sec,'both');assertCanonical(root,b);
  const zh = h.calls.text.find(call=>call.language==='zh');
  assert.deepEqual(zh.suppressedRanges,[{start:0,end:11}]);
  assert.equal(b.zh.slice(zh.suppressedRanges[0].end),'（仅作测试）');
  for(const language of ['en','zh']){const one = createHarness(p);one.render(sec,language);assert(one.calls.text.every(call=>call.suppressedRanges.length===0));}
});

test('title precedes a fixed-row actual-shaped table with all date/access blocks and ordinary remainder', () => {
  const sources = [
    block('type', 'Article', '研究论文'), block('title', 'A complete scientific title', '完整科学题名', {kind:'heading'}),
    block('doi', 'https://doi.org/10.1234/source', 'https://doi.org/10.1234/source'),
    block('received', 'Received: 27 February 2025', '收稿：27 February 2025'),
    block('accepted', 'Accepted: 7 August 2026', '接收：7 August 2026'),
    block('published', 'Published online: 09 September 2026', '在线发表：09 September 2026'),
    block('access', 'Open access', '开放获取'), block('updates', 'Check for updates', '检查更新'),
    block('authors', 'Complete Author¹, Second Author²', '完整作者¹、第二作者²'),
    block('affiliations', 'Full institution and correspondence', '完整单位和通信信息'),
    block('ordinary', 'Scientific remainder must stay ordinary.', '科学内容保留普通正文。', {kind:'methods'})
  ];
  const front = section('actual-shaped-information', sources.map(b=>b.blockId));
  const fields = [{key:'type',blockIds:['type']},{key:'title',blockIds:['title'],collapsed:true},
    {key:'doi',blockIds:['doi']},{key:'dates',blockIds:['received','accepted','published']},
    {key:'access',blockIds:['access','updates']},{key:'authors',blockIds:['authors'],collapsed:true},
    {key:'affiliations',blockIds:['affiliations'],collapsed:true}];
  const paper = makePaper([front],sources,{sectionIds:[front.sectionId],fields},{journal:'Nature',year:2026,authors:[],doi:'10.1234/source'});
  const before = structuredClone(paper), h = createHarness(paper), root = h.render(front,'both');
  assert(root.classList.contains('article-info-compact'));
  assert.deepEqual(root.querySelectorAll('[data-info-field]').map(row=>row.dataset.infoField),
    ['title','authors','journal-year','doi','type','dates','access','affiliations']);
  const title = field(root,'title'), table = root.querySelector('.article-info-fields');
  assert(title.matches('.article-info-titles')); assert.equal(title.dataset.infoLayout,'title');
  assert.equal(title.nextElementSibling,table); assert.equal(table.contains(title),false);
  assert.equal(title.querySelector('.info-label'),null,'canonical title has no extra field-label line');
  assert.equal(table.querySelector('[data-info-field=title]'),null,'no duplicated title row');
  for(const row of table.children){
    assertFieldStructure(row); assert.equal(row.children.length,2);
    assert.equal(row.dataset.infoLayout,'table-row');
  }
  assert.equal(root.querySelectorAll('details').length,0);
  assert.equal(field(root,'dates').querySelectorAll('.info-items .block').length,3);
  assert.equal(field(root,'access').querySelectorAll('.info-items .block').length,2);
  for(const source of sources)assertCanonical(root,source,source.en===source.zh);
  assert.equal(findBlock(root,'ordinary').closest('.article-info-fields'),null);
  assertSourceCalls(h.calls.source,sources);
  assert.deepEqual(paper,before);
});

test('explicit journal and year metadata share one row without fake source identities', () => {
  const first=section('first',[],{titleEn:'Article information'}),second=section('second',[],{titleEn:'Article info'});
  const paper=makePaper([first,second],[],undefined,{authors:[],doi:'',journal:'Nature',year:2026});
  const before=structuredClone(paper),h=createHarness(paper),root=h.mount(h.render(first,'both'),h.render(second,'zh'));
  const rows=root.querySelectorAll('[data-info-field]');
  assert.equal(rows.length,1);assertFieldStructure(rows[0]);
  assert.equal(rows[0].dataset.infoField,'journal-year');
  assert.equal(rows[0].querySelector('.info-label').textContent,'期刊与年份');
  assert.equal(rows[0].querySelector('.info-metadata-value').textContent,'Nature · 2026');
  assert.equal(rows[0].dataset.infoLayout,'table-row');
  assert.equal(root.querySelectorAll('[data-block-id]').length,0);
  assert.equal(root.querySelectorAll('.source-link').length,0);
  assert.equal(h.calls.text.length,0);assert.equal(h.calls.source.length,0);assert.deepEqual(paper,before);
});

test('journal-only and year-only metadata retain a complete single value without empty companion fields', () => {
  const front=section('frontmatter',[]);
  for(const [metadata,key,value]of [[{journal:'Nature'},'journal','Nature'],[{year:2026},'year','2026']]){
    const p=makePaper([front],[],undefined,{authors:[],doi:'',...metadata}),before=structuredClone(p),h=createHarness(p),root=h.render(front,'both');
    const rows=root.querySelectorAll('[data-info-field]');
    assert.equal(rows.length,1);assertFieldStructure(rows[0]);
    assert.equal(rows[0].dataset.infoField,key);assert.equal(rows[0].querySelector('.info-value').textContent,value);
    assert.equal(rows[0].querySelector('.info-value').textContent.includes(' · '),false);
    assert.equal(root.querySelectorAll('[data-block-id]').length,0);assert.deepEqual(p,before);
  }
});

test('a canonical journal or year is never absorbed into the combined metadata-only row', () => {
  for(const [sourceKey,sourceValue,otherKey,otherValue]of [['journal','Nature','year',2026],['year','2026','journal','Nature']]){
    const source=block('canonical-'+sourceKey,sourceValue,sourceValue,{infoField:sourceKey}),front=section('frontmatter',[source.blockId]);
    const p=makePaper([front],[source],undefined,{authors:[],doi:'',[sourceKey]:sourceKey==='year'?Number(sourceValue):sourceValue,[otherKey]:otherValue});
    const before=structuredClone(p),h=createHarness(p),root=h.render(front,'both');
    assertCanonical(root,source,true);assert.equal(field(root,'journal-year'),undefined);
    assert.equal(findBlock(root,source.blockId).closest('[data-info-field]').dataset.infoField,sourceKey);
    assert.equal(field(root,otherKey).querySelector('.info-value').textContent,String(otherValue));
    assert.equal(root.querySelectorAll('[data-info-field]').length,2);assertSourceCalls(h.calls.source,[source]);assert.deepEqual(p,before);
  }
});

test('journal/year fallback respects source mappings across information sections', () => {
  const journal=block('source-journal','Nature','Nature',{metadataKey:'journal'}),year=block('source-year','2026','2026',{infoField:'year'});
  const first=section('first',[],{titleEn:'Article information'}),second=section('second',[journal.blockId,year.blockId],{titleEn:'Article info'});
  const p=makePaper([first,second],[journal,year],undefined,{authors:[],doi:'',journal:'Nature',year:2026});
  const h=createHarness(p),root=h.mount(h.render(first,'both'),h.render(second,'both'));
  assertCanonical(root,journal,true);assertCanonical(root,year,true);
  assert.equal(root.querySelectorAll('.info-metadata-value').length,0);
  assert.equal(root.querySelectorAll('[data-info-field]').length,2);
  assert.deepEqual(h.calls.source,[journal,year]);
});

test('missing/invalid metadata does not infer journal or year from DOI, titles or dates', () => {
  const b=block('source-description','Nature article title; Published online: 2026; DOI 10.1038/source.', '标题和日期中的标识不作元数据推断。');
  const sec=section('frontmatter',[b.blockId]);
  for(const metadata of [{},{journal:{name:'Nature'},year:2026.5},{journal:' ',year:'2026-09-09'},{year:999},{year:3000},{publishedDate:'2026-09-09'}]){
    const p=makePaper([sec],[b],undefined,{authors:[],doi:'',...metadata}),h=createHarness(p),root=h.render(sec,'both');
    assert.equal(field(root,'journal'),undefined);assert.equal(field(root,'year'),undefined);assertCanonical(root,b);
  }
  const p=makePaper([sec],[b],undefined,{authors:[],doi:'',year:'invalid',publicationYear:'2026'}),h=createHarness(p),root=h.render(sec,'en');
  assert.equal(field(root,'year').querySelector('.info-metadata-value').textContent,'2026');assert.equal(field(root,'journal'),undefined);
});

test('title above the table preserves formatted highlighted callback DOM and exact navigation in all languages', () => {
  const title=block('canonical-title','A title with α² and 😀','包含 α² 和 😀 的标题',{kind:'heading'}),front=section('frontmatter',[title.blockId]);
  const p=makePaper([front],[title],{sectionIds:[front.sectionId],fields:[{key:'title',blockIds:[title.blockId],collapsed:true}]},{authors:[],doi:''});
  const before=structuredClone(p),h=createHarness(p,(source,language,prose,node)=>{
    const mark=node('mark',source[language]),em=node('em');mark.dataset.annotationId='existing-'+language;em.append(mark);prose.replaceChildren(em);
  });
  for(const language of ['both','en','zh']){
    const callStart=h.calls.text.length,root=h.render(front,language),wrapper=assertCanonical(root,title),titles=field(root,'title');
    assert(titles.matches('.article-info-titles')); assert.equal(wrapper.closest('details'),null);
    assert.equal(root.querySelector('.article-info-fields').contains(wrapper),false);
    assert.equal(wrapper.querySelectorAll('em').length,2);assert.equal(wrapper.querySelectorAll('mark').length,2);
    assert.equal(h.revealBlock(title.blockId,root),wrapper);assert.equal(h.revealBlock(title.blockId),wrapper);
    for(const call of h.calls.text.slice(callStart)){assert.equal(call.source,title);assert(wrapper.contains(call.prose));}
    wrapper.querySelector('.source-link').click();
  }
  assert.deepEqual(h.calls.clicked,[title.blockId,title.blockId,title.blockId]);assert.deepEqual(p,before);
});

test('long metadata-only authors remain visible while empty structured values add no rows', () => {
  const front=section('frontmatter',[]),authors=Array.from({length:35},(_,i)=>'Author '+i+' 𝛼');
  const p=makePaper([front],[],undefined,{authors,doi:'',journal:' ',year:'unknown'});
  const before=structuredClone(p),h=createHarness(p),root=h.render(front,'both');
  const row=field(root,'authors');assertFieldStructure(row);
  assert.equal(row.querySelector('.info-value').textContent,authors.join(', '));
  assert.equal(root.querySelectorAll('details').length,0);assert.equal(root.querySelectorAll('[data-info-field]').length,1);
  assert.equal(root.querySelectorAll('[data-block-id]').length,0);assert.deepEqual(p,before);
  const empty=makePaper([front],[],undefined,{authors:['','  ',null],doi:'  ',journal:' ',year:null});
  assert.equal(createHarness(empty).render(front,'both').querySelectorAll('[data-info-field]').length,0);
});

test('repeated DOI source records remain visible canonical entries without generated disclosure text', () => {
  const first=block('doi-original','https://doi.org/10.1234/duplicate'),second=block('doi-repeat','10.1234/duplicate');
  const front=section('frontmatter',[first.blockId,second.blockId]);
  const p=makePaper([front],[first,second],{sectionIds:[front.sectionId],fields:[{key:'doi',blockIds:[first.blockId,second.blockId],collapsed:true}]},{authors:[],doi:'10.1234/duplicate'});
  const before=structuredClone(p),h=createHarness(p),root=h.render(front,'both'),row=field(root,'doi');
  assertFieldStructure(row);assert.equal(root.querySelectorAll('details').length,0);
  assert.equal(row.querySelector('.info-value').children.length,2);
  assertCanonical(root,first,true);assertCanonical(root,second,true);
  assertSourceCalls(h.calls.source,[first,second]);assert.deepEqual(p,before);
});
