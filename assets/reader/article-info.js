(function (global, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global) global.MicroPaperArticleInfo = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const LABELS = {
    title: ['Title', '题名'],
    authors: ['Authors', '作者'],
    affiliations: ['Affiliations', '机构'],
    journal: ['Journal', '期刊'],
    year: ['Year', '年份'],
    'journal-year': ['Journal and year', '期刊与年份'],
    doi: ['DOI', 'DOI'],
    received: ['Received', '收稿'],
    accepted: ['Accepted', '接收'],
    published: ['Published', '发表'],
    metadata: ['Publication details', '出版信息']
  };
  const SEMANTIC_NAMES = new Set([
    'frontmatter', 'articleinformation', 'articleinfo', '文章信息', '文献信息', '论文信息'
  ]);
  const normalizedName = value => typeof value === 'string'
    ? value.toLowerCase().replace(/[\s_-]+/g, '') : '';
  function semanticKey(value) {
    const key = typeof value === 'string' ? value.toLowerCase() : '';
    return key === 'affiliation' ? 'affiliations' : key;
  }
  // This is a comparison key only. Never replace a canonical source string with it.
  function doiKey(value) {
    if (typeof value !== 'string') return '';
    const doi = value.trim().replace(/^doi\s*:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : '';
  }

  function createArticleInfo({paper, node, renderText, blocksById, sourceButton} = {}) {
    if (!paper || typeof paper !== 'object') throw TypeError('Article information requires paper data');
    if (typeof node !== 'function' || typeof renderText !== 'function') {
      throw TypeError('Article information requires node and canonical renderText callbacks');
    }
    const lookup = blocksById || new Map((paper.blocks || []).map(b => [b.blockId, b]));
    const getBlock = id => typeof lookup.get === 'function' ? lookup.get(id) : lookup[id];
    const roots = new Map();
    const configuration = () => paper.articleInfo || {};
    const configuredFields = () => Array.isArray(configuration().fields) ? configuration().fields : [];
    const isExcluded = block => ['header-footer', 'figure-label'].includes(block.kind);
    function sourceBlocks(section) {
      const seen = new Set();
      return (Array.isArray(section.blockIds) ? section.blockIds : [])
        .filter(id => typeof id === 'string' && !seen.has(id) && seen.add(id))
        .map(getBlock).filter(block => block && !isExcluded(block));
    }
    function handles(section) {
      if (!section || typeof section !== 'object') return false;
      const config = configuration();
      if (Array.isArray(config.sectionIds) && config.sectionIds.includes(section.sectionId)) return true;
      // An explicit field/source mapping also identifies its owning section.
      const localIds = Array.isArray(section.blockIds) ? section.blockIds : [];
      if (configuredFields().some(field => field && Array.isArray(field.blockIds) &&
        field.blockIds.some(id => localIds.includes(id)))) return true;
      if ([section.sectionId, section.titleEn, section.titleZh].some(value =>
        SEMANTIC_NAMES.has(normalizedName(value)))) return true;
      return typeof section.sectionId === 'string' &&
        /(?:^|[-_\s])(?:front[-_\s]?matter|article[-_\s]?(?:information|info))(?:$|[-_\s])/i
          .test(section.sectionId);
    }
    function inferredKey(block) {
      const explicit = semanticKey(block.infoField || block.metadataKey);
      if (Object.prototype.hasOwnProperty.call(LABELS, explicit)) return explicit;
      const kind = semanticKey(block.kind);
      if (['title', 'authors', 'affiliations', 'doi'].includes(kind)) return kind;
      if (kind === 'metadata') {
        const doi = doiKey(paper.metadata?.doi);
        if (doi && [block.en, block.zh].some(text => doiKey(text) === doi)) return 'doi';
        return 'metadata';
      }
      return '';
    }
    function groupsFor(section) {
      const blocks = sourceBlocks(section), local = new Map(blocks.map(b => [b.blockId, b]));
      const assigned = new Set(), fields = [];
      for (const field of configuredFields()) {
        if (!field || typeof field !== 'object' || !Array.isArray(field.blockIds)) continue;
        const owned = [];
        for (const id of field.blockIds) {
          if (local.has(id) && !assigned.has(id)) {
            assigned.add(id); owned.push(local.get(id));
          }
        }
        if (owned.length) fields.push({...field, key: semanticKey(field.key) || 'metadata', blocks: owned});
      }
      const inferred = new Map(), remaining = [];
      for (const block of blocks) {
        if (assigned.has(block.blockId)) continue;
        const key = inferredKey(block);
        if (!key) {remaining.push(block); continue;}
        if (!inferred.has(key)) {
          const field = {key, blocks: []}; inferred.set(key, field); fields.push(field);
        }
        inferred.get(key).blocks.push(block); assigned.add(block.blockId);
      }
      // Repeated semantic keys form one row; every distinct source block remains owned once.
      const merged = new Map();
      for (const field of fields) {
        if (merged.has(field.key)) merged.get(field.key).blocks.push(...field.blocks);
        else merged.set(field.key, field);
      }
      return {fields: [...merged.values()], remaining};
    }
    function label(field, language) {
      const defaults = Object.prototype.hasOwnProperty.call(LABELS, field.key)
        ? LABELS[field.key] : [field.key, field.key];
      return language === 'en' ? field.labelEn || defaults[0]
        : field.labelZh || field.labelEn || defaults[1];
    }
    function sharedDoiRanges(block, language, key) {
      if (language !== 'both' || key !== 'doi' || block.en === block.zh) return [];
      const value = paper.metadata?.doi;
      const escaped = typeof value === 'string' ? doiKey(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
      if (!escaped) return [];
      const pattern = '(?:https?:\\/\\/(?:dx\\.)?doi\\.org\\/)?' + escaped;
      if (!new RegExp(pattern, 'i').test(block.en || '')) return [];
      return [...String(block.zh || '').matchAll(new RegExp(pattern, 'gi'))]
        .map(match => ({start: match.index, end: match.index + match[0].length}));
    }
    function canonicalBlock(block, language, fieldKey) {
      const kindClass = /^[a-z][a-z0-9_-]*$/i.test(block.kind || '') ? ' ' + block.kind : '';
      const wrap = node('div', undefined, 'block article-info-block' + kindClass);
      // Keep source IDs as data/ID values rather than interpolating them into selectors.
      wrap.id = block.blockId; wrap.dataset.blockId = block.blockId;
      wrap.dataset.sourceKind = block.kind;
      const en = renderText(block, 'en'), zh = renderText(block, 'zh', true, sharedDoiRanges(block, language, fieldKey));
      const shared = language === 'both' && typeof block.en === 'string' &&
        block.en === block.zh;
      if (shared) {
        wrap.className += ' article-info-shared';
        zh.dataset.duplicate = 'true';
      }
      // Both prose nodes always remain in the DOM, including a visually shared translation.
      wrap.append(en, zh);
      if (typeof sourceButton === 'function') {
        const button = sourceButton(block);
        if (button) wrap.append(button);
      }
      return wrap;
    }
    function appendValue(value, field, language) {
      if (!field.blocks) {
        // Structured metadata has no source block/annotation coordinates. Do not fabricate IDs.
        const text = node('p', field.value, 'info-metadata-value');
        text.dataset.metadataKey = field.key; value.append(text); return;
      }
      for (const block of field.blocks) value.append(canonicalBlock(block, language, field.key));
    }
    function fieldRow(field, language) {
      // Legacy collapsed hints remain in paper data, but all information is
      // visible in this table. Long source strings wrap without truncation.
      const row = node('div', undefined, 'info-field info-row');
      row.dataset.infoField = field.key;
      row.dataset.infoLayout = 'table-row';
      row.append(node('div', label(field, language), 'info-label'));
      const value = node('div', undefined, 'info-value'); row.append(value);
      if (field.blocks?.length > 1 && ['dates', 'access'].includes(field.key)) {
        value.className += ' info-items';
      }
      appendValue(value, field, language);
      return row;
    }
    function metadataFallback(section) {
      const sections = (paper.sections || []).filter(handles);
      const currentId = section.sectionId;
      // Put structured metadata in the first recognized information section only.
      if (sections.length && sections[0].sectionId !== currentId) return [];
      const represented = new Set((sections.length ? sections : [section])
        .flatMap(sec => groupsFor(sec).fields.filter(f => f.blocks.length).map(f => f.key)));
      const result = [], metadata = paper.metadata || {};
      const authors = Array.isArray(metadata.authors)
        ? metadata.authors.filter(value => typeof value === 'string' && value.trim()).join(', ')
        : typeof metadata.authors === 'string' && metadata.authors.trim() ? metadata.authors : '';
      const representedBlocks = (sections.length ? sections : [section]).flatMap(sourceBlocks);
      const journal = typeof metadata.journal === 'string' && metadata.journal.trim() ? metadata.journal : '';
      const year = [metadata.year, metadata.publicationYear].find(value =>
        typeof value === 'number' ? Number.isInteger(value) && value >= 1000 && value <= 2999
          : typeof value === 'string' && /^[12][0-9]{3}$/.test(value));
      for (const block of representedBlocks) {
        const key = inferredKey(block);
        if (key) represented.add(key);
        if (authors && [block.en, block.zh].includes(authors)) represented.add('authors');
        const doi = doiKey(metadata.doi);
        if (doi && [block.en, block.zh].some(text => doiKey(text) === doi)) represented.add('doi');
        if (journal && [block.en, block.zh].includes(journal)) represented.add('journal');
        if (year !== undefined && [block.en, block.zh].includes(String(year))) represented.add('year');
      }
      // Only explicit structured values are used. In particular, never infer
      // a journal from DOI prefixes, a title, headers or scientific prose.
      const journalValue = !represented.has('journal') && journal;
      const yearValue = !represented.has('year') && year !== undefined ? String(year) : '';
      if (journalValue && yearValue) {
        // Combine only metadata-only values. Canonical source blocks keep their
        // own rows and IDs, even when one of these values has a source mapping.
        result.push({key:'journal-year', value:journalValue + ' · ' + yearValue});
      } else {
        if (journalValue) result.push({key:'journal', value:journalValue});
        if (yearValue) result.push({key:'year', value:yearValue});
      }
      if (!represented.has('authors') && authors) result.push({key: 'authors', value: authors});
      if (!represented.has('doi') && typeof metadata.doi === 'string' && metadata.doi.trim()) {
        result.push({key: 'doi', value: metadata.doi});
      }
      return result;
    }
    function render(section, language = 'both') {
      if (!handles(section)) return null;
      if (!['both', 'en', 'zh'].includes(language)) throw TypeError('Unknown article information language');
      const sec = node('section', undefined, 'article-info article-info-compact article-info-table language-' + language);
      sec.id = section.sectionId || ''; sec.dataset.role = 'article-info';
      const {fields, remaining} = groupsFor(section);
      const titles = fields.filter(field => field.key === 'title');
      if (titles.length) {
        const title = node('div', undefined, 'article-info-titles');
        title.dataset.infoField = 'title'; title.dataset.infoLayout = 'title';
        const value = node('div', undefined, 'info-value'); title.append(value);
        for (const field of titles) appendValue(value, field, language);
        sec.append(title);
      } else {
        const heading = node('h2', language === 'en' ? section.titleEn || 'Article information'
          : section.titleZh || section.titleEn || '文章信息', 'article-info-heading');
        sec.append(heading);
      }
      const grid = node('div', undefined, 'article-info-fields'); sec.append(grid);
      const fallback = metadataFallback(section);
      const order = ['authors', 'journal-year', 'journal', 'year', 'doi', 'type', 'dates', 'received', 'accepted', 'published', 'access', 'affiliations'];
      const rank = field => {const index = order.indexOf(field.key); return index < 0 ? order.length : index;};
      // Display order is independent of canonical IDs and source strings.
      // Unrecognized fields retain their relative order and all source blocks.
      const rows = [...fields.filter(field => field.key !== 'title'), ...fallback]
        .map((field, index) => ({field, index}))
        .sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index);
      for (const {field} of rows) {
        grid.append(fieldRow(field, language));
      }
      if (remaining.length) {
        // Unknown/ordinary scientific material never gets converted to a metadata value or dropped.
        const rest = node('div', undefined, 'article-info-remainder');
        for (const block of remaining) rest.append(canonicalBlock(block, language));
        sec.append(rest);
      }
      roots.set(section.sectionId || section, sec);
      return sec;
    }
    function revealBlock(blockId, rootNode) {
      const candidates = rootNode ? [rootNode] : [...roots.values()];
      for (const root of candidates) {
        const all = [...(root.querySelectorAll?.('.block[data-block-id]') || [])];
        if (root.dataset?.blockId === blockId) all.unshift(root);
        const target = all.find(el => el.dataset?.blockId === blockId);
        if (!target) continue;
        return target;
      }
      return null;
    }
    return {render, revealBlock, handles};
  }
  return {createArticleInfo};
});
