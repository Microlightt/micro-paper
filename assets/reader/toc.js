/* Navigation only: no canonical strings, IDs, body order, figures or storage changes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MicroPaperToc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const mounted = new WeakMap();
  const excluded = new Set(['caption', 'header-footer', 'figure-label']);
  const text = value => typeof value === 'string' ? value : '';
  const same = (a, b) => text(a).trim().replace(/\s+/g, ' ') === text(b).trim().replace(/\s+/g, ' ');

  function createTree(paper) {
    paper = paper || {};
    const blocks = new Map((paper.blocks || []).map(block => [block.blockId, block]));
    const sections = paper.sections || [];
    const sectionMap = new Map(sections.map(section => [section.sectionId, section]));
    const usable = section => (section.blockIds || []).map(id => blocks.get(id)).filter(block => block && !excluded.has(block.kind));
    const visibleSections = sections.filter(section => usable(section).length);
    const sectionForBlock = new Map();
    for (const section of sections) for (const id of section.blockIds || []) {
      if (!sectionForBlock.has(id)) sectionForBlock.set(id, []);
      sectionForBlock.get(id).push(section.sectionId);
    }
    const usedIds = new Set(), issues = [];
    let sequence = 0;
    function target(id) {
      if (typeof id !== 'string' || !id) return null;
      const block = blocks.get(id);
      if (block) return excluded.has(block.kind) ? null : {id, block};
      const section = sectionMap.get(id);
      return section && usable(section).length ? {id, section} : null;
    }
    function labels(node, destination) {
      const source = destination?.section;
      const heading = destination?.block?.kind === 'heading' ? destination.block : null;
      const en = text(node.titleEn) || text(source?.titleEn) || text(heading?.en);
      const zh = text(node.titleZh) || text(source?.titleZh) || text(heading?.zh);
      return {titleEn: en || zh, titleZh: zh || en};
    }
    function fallback(section) {
      const source = usable(section), firstHeading = source.find(block => block.kind === 'heading');
      const children = source.filter(block => block.kind === 'heading' && !(block === firstHeading && same(block.en, section.titleEn) && same(block.zh, section.titleZh)))
        .map(block => ({id: 'heading:' + block.blockId, titleEn: block.en, titleZh: block.zh, targetId: block.blockId, role: 'source'}));
      return {id: 'section:' + section.sectionId, titleEn: section.titleEn, titleZh: section.titleZh,
        targetId: section.sectionId, role: 'source', children};
    }
    function normalize(node, depth, ancestors) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || ancestors.has(node) || depth > 16) {
        issues.push({code: 'invalid-node', detail: 'TOC node is invalid or recursively nested'}); return null;
      }
      const chain = new Set(ancestors); chain.add(node);
      const children = (Array.isArray(node.children) ? node.children : []).map(child => normalize(child, depth + 1, chain)).filter(Boolean);
      const destination = target(node.targetId);
      if (node.targetId && !destination) issues.push({code: 'excluded-or-missing-target', targetId: node.targetId});
      if (!destination && !children.length) return null;
      const titles = labels(node, destination);
      if (!titles.titleEn || !titles.titleZh) {issues.push({code: 'missing-label', targetId: node.targetId}); return null;}
      let id = text(node.id) || 'item:' + (++sequence);
      if (usedIds.has(id)) {
        issues.push({code: 'duplicate-item-id', id});
        const prefix = id; do {id = prefix + ':' + (++sequence);} while (usedIds.has(id));
      }
      usedIds.add(id);
      const result = {id, ...titles, role: node.role === 'navigation-group' ? 'navigation-group' : 'source', children};
      if (destination) result.targetId = destination.id;
      if (typeof node.open === 'boolean') result.open = node.open;
      if (Array.isArray(node.sourceBlockIds)) result.sourceBlockIds = node.sourceBlockIds.filter(id => typeof id === 'string').slice();
      if (typeof node.evidence === 'string') result.evidence = node.evidence;
      return result;
    }
    const configuration = paper.toc === undefined ? paper.readerSettings?.toc : paper.toc;
    let source = 'fallback', items;
    if (configuration && configuration.version === 1 && Array.isArray(configuration.items)) {
      source = 'explicit';
      items = configuration.items.map(node => normalize(node, 0, new Set())).filter(Boolean);
      const destinations = new Set();
      const collect = item => {if (item.targetId) destinations.add(item.targetId); item.children.forEach(collect);};
      items.forEach(collect);
      const sectionIndex = new Map(sections.map((section, index) => [section.sectionId, index]));
      const compareRank = (a, b) => a[0] - b[0] || a[1] - b[1];
      const targetRank = id => {
        if (sectionMap.has(id)) return [sectionIndex.get(id), -1];
        const sid = sectionForBlock.get(id)?.[0];
        return sid === undefined ? [Infinity, Infinity] : [sectionIndex.get(sid), sectionMap.get(sid).blockIds.indexOf(id)];
      };
      const itemRank = item => [item.targetId ? targetRank(item.targetId) : [Infinity, Infinity], ...item.children.map(itemRank)]
        .reduce((first, next) => compareRank(next, first) < 0 ? next : first, [Infinity, Infinity]);
      // Explicit navigation must not make unknown non-caption source sections unreachable.
      for (const section of visibleSections) {
        const sourceBlocks = usable(section), headings = sourceBlocks.filter(block => block.kind === 'heading');
        const sourceTargets = headings.length ? headings : sourceBlocks;
        const covered = destinations.has(section.sectionId) || sourceTargets.every(block => destinations.has(block.blockId));
        if (covered) continue;
        issues.push({code: 'unlisted-section-preserved', sectionId: section.sectionId});
        const extra = fallback(section); extra.children = extra.children.filter(child => !destinations.has(child.targetId));
        const item = normalize(extra, 0, new Set());
        if (item) {
          const position = items.findIndex(existing => compareRank(itemRank(existing), itemRank(item)) > 0);
          items.splice(position === -1 ? items.length : position, 0, item); collect(item);
        }
      }
    } else {
      if (configuration !== undefined) issues.push({code: 'invalid-configuration', detail: 'Expected toc version 1 and items array'});
      items = visibleSections.map(section => normalize(fallback(section), 0, new Set())).filter(Boolean);
    }
    return {items, issues, source};
  }

  function render(root, paper, navigate, options) {
    if (!root || !root.ownerDocument || typeof root.replaceChildren !== 'function') throw new TypeError('TOC root element required');
    mounted.get(root)?.destroy();
    const doc = root.ownerDocument, tree = createTree(paper), settings = options || {};
    const previousRole = root.getAttribute('role'), previousLabel = root.getAttribute('aria-label');
    const listeners = [], groups = [];
    const make = (tag, cls) => {const element = doc.createElement(tag); if (cls) element.className = cls; return element;};
    const bilingual = (element, item) => {
      const en = make('span', 'toc-en'), zh = make('span', 'toc-zh');
      en.lang = 'en'; zh.lang = 'zh-Hans'; en.textContent = item.titleEn; zh.textContent = item.titleZh;
      element.append(en, zh); return element;
    };
    function link(item) {
      const anchor = bilingual(make('a', 'toc-link'), item);
      anchor.href = '#' + encodeURIComponent(item.targetId); anchor.dataset.tocTarget = item.targetId;
      if (typeof navigate === 'function') {
        const click = event => {
          if (event.button > 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault(); navigate(item.targetId, {item, event, anchor});
        };
        anchor.addEventListener('click', click); listeners.push(() => anchor.removeEventListener('click', click));
      }
      return anchor;
    }
    function itemNode(item, level) {
      const li = make('li', 'toc-item'); li.dataset.tocId = item.id;
      if (!item.children.length) {li.append(link(item)); return li;}
      const details = make('details', 'toc-group'), summary = make('summary', 'toc-summary');
      details.dataset.tocId = item.id; details.dataset.tocLevel = String(level);
      details.open = item.open === undefined ? settings.defaultOpen === true : item.open;
      summary.append(item.targetId ? link(item) : bilingual(make('span', 'toc-group-label'), item));
      details.append(summary); groups.push(details);
      const children = make('ul', 'toc-children');
      for (const child of item.children) children.append(itemNode(child, level + 1));
      details.append(children); li.append(details); return li;
    }
    const list = make('ul', 'toc-list');
    for (const item of tree.items) list.append(itemNode(item, 1));
    root.setAttribute('role', 'navigation'); root.setAttribute('aria-label', 'Article contents / 文章目录');
    root.replaceChildren(list);
    let destroyed = false;
    const controller = {tree: tree.items, issues: tree.issues, source: tree.source,
      expandAll() {if (!destroyed) groups.forEach(group => {group.open = true;});},
      collapseAll() {if (!destroyed) groups.forEach(group => {group.open = false;});},
      destroy() {
        if (destroyed) return; destroyed = true;
        listeners.splice(0).forEach(remove => remove());
        if (list.parentElement === root) list.remove();
        for (const [key, value] of [['role', previousRole], ['aria-label', previousLabel]]) value === null ? root.removeAttribute(key) : root.setAttribute(key, value);
        if (mounted.get(root) === controller) mounted.delete(root);
      }
    };
    mounted.set(root, controller); return controller;
  }
  return {createTree, render};
});
