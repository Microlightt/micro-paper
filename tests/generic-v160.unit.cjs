#!/usr/bin/env node
'use strict';
// Tiny self-authored audit fixtures. No real paper, PDF extraction, browser, network,
// translation, or installed-skill mutation is involved in this test suite.
// Run: node --test tests/generic-v160.unit.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { auditSource, auditEmbeddedAssets, glyphDigest, assertUTF16Range, Blocked } = require('./reader-generic-v160.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const sourceSha256 = hash('self-authored unit fixture source, not an actual PDF');
  const glyphs = [
    [{ text: 'A', font: 'FixtureSerif', size: 10, bbox: [1, 2, 4, 12] },
      { text: '😀', font: 'FixtureSerif', size: 10, bbox: [4, 2, 10, 12] },
      { text: 'B', font: 'FixtureSerif', size: 10, bbox: [10, 2, 14, 12] }],
    [{ text: 'C', font: 'FixtureSans', size: 9, bbox: [2, 3, 6, 12] },
      { text: 'D', font: 'FixtureSans', size: 9, bbox: [6, 3, 10, 12] }]
  ];
  const pages = [
    { number: 1, pageId: 'source-p1', width: 100, height: 200, rotation: 0 },
    { number: 2, pageId: 'source-p2', width: 200, height: 100, rotation: 90 }
  ];
  const inventory = {
    schemaVersion: 1, independentOfPaper: true, sourceSha256, pageCount: 2,
    provenance: { input: 'source.pdf', tool: 'self-authored-unit-inventory', version: '1' },
    pages: pages.map((p, n) => ({ number: p.number, pageId: p.pageId, width: p.width, height: p.height,
      rotation: p.rotation, glyphCount: glyphs[n].length, glyphs: clone(glyphs[n]),
      images: n === 1 ? [{ regionId: 'graphic-figure', bbox: [4, 30, 60, 70] }] : [],
      drawings: n === 0 ? [{ regionId: 'graphic-decoration', bbox: [0, 20, 100, 21] }]
        : [{ regionId: 'graphic-table', bbox: [80, 30, 130, 70] }] }))
  };
  const paper = {
    sourceSha256, pages: clone(pages),
    blocks: [
      { blockId: 'body-a', kind: 'body', en: 'A😀B', zh: '自造正文甲',
        sourceSpans: [{ pageId: 'source-p1', glyphStart: 0, glyphEnd: 3, bbox: [1, 2, 14, 12] }] },
      { blockId: 'caption-b', kind: 'caption', en: 'CD', zh: '自造图注乙',
        sourceSpans: [{ pageId: 'source-p2', glyphStart: 0, glyphEnd: 2, bbox: [2, 3, 10, 12] }] }
    ].map(b => ({ ...b, enHash: hash(b.en), zhHash: hash(b.zh) })),
    figures: [{ figureId: 'figure-a', sourcePageId: 'source-p2', crop: [4, 30, 60, 70], captionBlockIds: ['caption-b'] }]
  };
  const inventorySha256 = hash(JSON.stringify(inventory));
  return {
    sourceSha256, inventorySha256, paper, inventory,
    manifest: { sourceSha256, pages: pages.map((p, n) => ({ ...p, glyphs: clone(glyphs[n]) })) },
    figureLedger: {
      sourceSha256, inventorySha256, figureLedgerComplete: true,
      pageReviews: [
        { pageId: 'source-p1', status: 'pass', evidence: 'Self-authored page 1 reviewed in full.', graphics: [
          { regionIds: ['graphic-decoration'], decision: 'decoration', evidence: 'Self-authored horizontal divider.' }
        ] },
        { pageId: 'source-p2', status: 'pass', evidence: 'Self-authored page 2 reviewed in full.', graphics: [
          { regionIds: ['graphic-figure'], decision: 'figure', evidence: 'Self-authored diagram.', figureIds: ['figure-a'] },
          { regionIds: ['graphic-table'], decision: 'table', evidence: 'Self-authored table retained in source view.' }
        ] }
      ],
      figures: [{ figureId: 'figure-a', sourcePageNumber: 2, crop: [4, 30, 60, 70],
        captionBlockIds: ['caption-b'], sourceEvidence: { fixtureOnly: true, region: 'self-authored diagram' },
        captionEvidence: [{ blockId: 'caption-original', canonicalBlockId: 'caption-b', enHash: hash('CD'),
          sourceSpans: [{ pageId: 'source-p2', glyphStart: 0, glyphEnd: 2, bbox: [2, 3, 10, 12] }],
          sourceEvidence: 'Self-authored original caption CD.' }],
        captionGlyphRanges: [{ blockId: 'caption-original', canonicalBlockId: 'caption-b', pageId: 'source-p2', glyphStart: 0, glyphEnd: 2, bbox: [2, 3, 10, 12] }],
        captionBlockMappings: [{ originalBlockId: 'caption-original', canonicalBlockId: 'caption-b', start: 0, end: 2 }]
      }]
    }
  };
}

function rejectMutation(mutate, expected) {
  const data = fixture(); mutate(data);
  assert.throws(() => auditSource(data), expected);
}

function splitCaptionProof(data) {
  const figure = data.figureLedger.figures[0];
  figure.captionEvidence = [
    { blockId: 'original-C', canonicalBlockId: 'caption-b', enHash: hash('C'),
      sourceSpans: [{ pageId: 'source-p2', glyphStart: 0, glyphEnd: 1, bbox: [2, 3, 6, 12] }],
      sourceEvidence: 'Self-authored original first caption fragment C.' },
    { blockId: 'original-D', canonicalBlockId: 'caption-b', enHash: hash('D'),
      sourceSpans: [{ pageId: 'source-p2', glyphStart: 1, glyphEnd: 2, bbox: [6, 3, 10, 12] }],
      sourceEvidence: 'Self-authored original second caption fragment D.' }
  ];
  figure.captionGlyphRanges = [
    { blockId: 'original-C', canonicalBlockId: 'caption-b', pageId: 'source-p2', glyphStart: 0, glyphEnd: 1, bbox: [2, 3, 6, 12] },
    { blockId: 'original-D', canonicalBlockId: 'caption-b', pageId: 'source-p2', glyphStart: 1, glyphEnd: 2, bbox: [6, 3, 10, 12] }
  ];
  figure.captionBlockMappings = [
    { originalBlockId: 'original-C', canonicalBlockId: 'caption-b', start: 0, end: 1 },
    { originalBlockId: 'original-D', canonicalBlockId: 'caption-b', start: 1, end: 2 }
  ];
  return figure;
}

test('valid independent full-glyph inventory proves every source glyph once', () => {
  const data = fixture();
  assert.notEqual(data.inventory.pages[0].glyphs, data.manifest.pages[0].glyphs);
  const before = clone(data), report = auditSource(data);
  assert.equal(report.pageCount, 2);
  assert.equal(report.glyphCount, 5); // Emoji is one source glyph, two UTF-16 units.
  assert.equal(report.figureCount, 1);
  assert.deepEqual(report.figureReview, { reviewedPages: 2, graphicFigures: 1,
    captions: [{ figureId: 'figure-a', blockId: 'caption-b', originalBlocks: ['caption-original'], glyphCount: 2 }] });
  assert.equal(report.sourceSha256, data.sourceSha256);
  assert.deepEqual(report.pages.map(p => [p.number, p.pageId, p.glyphCount]), [[1, 'source-p1', 3], [2, 'source-p2', 2]]);
  assert.deepEqual(data, before, 'Audit must not repair or mutate evidence to make it pass');
});

test('independently recorded digest-only pages also prove exact identity', () => {
  const data = fixture();
  for (const page of data.inventory.pages) {
    page.glyphSha256 = glyphDigest(page.glyphs);
    delete page.glyphs;
  }
  data.inventorySha256 = hash(JSON.stringify(data.inventory));
  data.figureLedger.inventorySha256 = data.inventorySha256;
  assert.equal(auditSource(data).glyphCount, 5);
});

test('glyph digest has a documented exact tuple representation', () => {
  const records = [
    { bbox: [0, 1, 2, 3], size: 11, font: 'Unit', text: 'A', nonIdentityMetadata: 42 },
    { text: '😀', font: 'Unit', size: 11, bbox: [2, 1, 4, 3] }
  ];
  const expectedSerialization = '[["A","Unit",11,[0,1,2,3]],["😀","Unit",11,[2,1,4,3]]]';
  assert.equal(glyphDigest(records), hash(expectedSerialization));
  assert.equal(glyphDigest([]), hash('[]'));
});

test('equal glyph counts cannot conceal changed source identity', async t => {
  const mutations = {
    text: g => { g.text = 'Z'; }, font: g => { g.font = 'SubstitutedFont'; },
    size: g => { g.size = 10.1; }, bbox: g => { g.bbox[0] = 1.1; }
  };
  for (const [field, mutate] of Object.entries(mutations)) await t.test(field, () => {
    const data = fixture(), count = data.manifest.pages[0].glyphs.length;
    mutate(data.manifest.pages[0].glyphs[0]);
    assert.equal(data.manifest.pages[0].glyphs.length, count);
    assert.throws(() => auditSource(data), /Independent source glyph identity mismatch page 1/);
  });
});

test('a reordered or truncated extraction fails independent glyph identity', async t => {
  await t.test('same count, reordered glyphs', () => rejectMutation(d => d.manifest.pages[0].glyphs.reverse(), /Independent source glyph identity mismatch/));
  await t.test('manifest and paper agree after truncation but original inventory does not', () => rejectMutation(d => {
    d.manifest.pages[0].glyphs.pop();
    Object.assign(d.paper.blocks[0].sourceSpans[0], { glyphEnd: 2, bbox: [1, 2, 10, 12] });
  }, /Independent source glyph identity mismatch/));
});

test('a count-only inventory cannot establish source identity', () => rejectMutation(d => {
  delete d.inventory.pages[0].glyphs;
}, /lacks independent exact glyph identity/));

test('unassigned source glyphs fail even when all source identities match', () => rejectMutation(d => {
  Object.assign(d.paper.blocks[0].sourceSpans[0], { glyphEnd: 2, bbox: [1, 2, 10, 12] });
}, /Missing or duplicated source glyph assignment source-p1/));

test('duplicated assignment fails even if missing glyphs keep total assignments equal', () => rejectMutation(d => {
  // First interval assigns A+emoji, second repeats emoji; B is missing.
  // Total assignments remain five across the document, so totals alone are insufficient.
  d.paper.blocks[0].sourceSpans = [
    { pageId: 'source-p1', glyphStart: 0, glyphEnd: 2, bbox: [1, 2, 10, 12] },
    { pageId: 'source-p1', glyphStart: 1, glyphEnd: 2, bbox: [4, 2, 10, 12] }
  ];
}, /Missing or duplicated source glyph assignment source-p1/));

test('adjacent cross-page source spans can cover all glyphs exactly once', () => {
  const data = fixture();
  Object.assign(data.paper.blocks[0], { en: 'A😀', enHash: hash('A😀') });
  Object.assign(data.paper.blocks[0].sourceSpans[0], { glyphEnd: 2, bbox: [1, 2, 10, 12] });
  Object.assign(data.paper.blocks[1], { en: 'BCD', enHash: hash('BCD') });
  const leading = { pageId: 'source-p1', glyphStart: 2, glyphEnd: 3, bbox: [10, 2, 14, 12] };
  data.paper.blocks[1].sourceSpans.unshift(clone(leading));
  const proof = data.figureLedger.figures[0];
  proof.captionEvidence[0].sourceSpans.unshift(clone(leading));
  proof.captionEvidence[0].enHash = hash('BCD');
  proof.captionEvidence[0].sourceEvidence = 'Self-authored caption BCD continues across two pages.';
  proof.captionGlyphRanges.unshift({ blockId: 'caption-original', canonicalBlockId: 'caption-b', ...leading });
  proof.captionBlockMappings[0].end = 3;
  assert.equal(auditSource(data).glyphCount, 5);
});

test('source interval bounds, existence and geometry are checked', async t => {
  for (const [label, patch] of [
    ['negative', { glyphStart: -1 }], ['empty', { glyphStart: 1, glyphEnd: 1 }],
    ['fractional', { glyphEnd: 2.5 }], ['past end', { glyphEnd: 4 }]
  ]) await t.test(label, () => rejectMutation(d => Object.assign(d.paper.blocks[0].sourceSpans[0], patch), /Invalid source glyph interval/));
  await t.test('unknown page', () => rejectMutation(d => { d.paper.blocks[0].sourceSpans[0].pageId = 'missing'; }, /Unknown source page/));
  await t.test('wrong bounding box', () => rejectMutation(d => { d.paper.blocks[0].sourceSpans[0].bbox[2] = 15; }, /bbox\/glyph identity mismatch/));
  await t.test('unproven block', () => rejectMutation(d => { d.paper.blocks[0].sourceSpans = []; }, /Unproven canonical block/));
});

test('transcription is blocked rather than accepted as glyph-count proof', () => {
  const data = fixture(); data.paper.blocks[0].sourceSpans[0].transcription = true;
  assert.throws(() => auditSource(data), error => error instanceof Blocked && /independent transcription\/region audit/.test(error.message));
});

test('canonical hashes and unique block identities remain required', async t => {
  await t.test('English hash', () => rejectMutation(d => { d.paper.blocks[0].en += ' altered'; }, /Stale canonical text hash/));
  await t.test('Chinese hash', () => rejectMutation(d => { d.paper.blocks[0].zh += '改'; }, /Stale canonical text hash/));
  await t.test('duplicate block identity', () => rejectMutation(d => { d.paper.blocks[1].blockId = d.paper.blocks[0].blockId; }, /Duplicate canonical block ID/));
});

test('paper, manifest and independent inventory bind the actual source SHA', async t => {
  for (const label of ['paper', 'manifest', 'inventory']) await t.test(label, () => rejectMutation(d => { d[label].sourceSha256 = hash('different source'); }, new RegExp(label + ' source SHA differs')));
});

test('independence declaration and extractor provenance are mandatory', async t => {
  for (const independentOfPaper of [false, undefined, 'true']) await t.test('flag ' + String(independentOfPaper), () => rejectMutation(d => { d.inventory.independentOfPaper = independentOfPaper; }, /explicitly originate from source.pdf independently/));
  await t.test('derived from paper.json', () => rejectMutation(d => { d.inventory.provenance.input = 'paper.json'; }, /explicitly originate from source.pdf independently/));
  for (const field of ['tool', 'version']) await t.test('missing ' + field, () => rejectMutation(d => { delete d.inventory.provenance[field]; }, /extractor tool\/version missing/));
  await t.test('unknown schema', () => rejectMutation(d => { d.inventory.schemaVersion = 2; }, /Unsupported independent inventory schema/));
});

test('source page order, count, identity and geometry must match', async t => {
  await t.test('incomplete independent inventory', () => rejectMutation(d => d.inventory.pages.pop(), /Independent page inventory incomplete/));
  await t.test('missing canonical page', () => rejectMutation(d => d.paper.pages.pop(), /Source page count mismatch/));
  await t.test('inventory order', () => rejectMutation(d => d.inventory.pages.reverse(), /Independent page sequence mismatch/));
  await t.test('page ID', () => rejectMutation(d => { d.paper.pages[0].pageId = 'different'; }, /Page identity differs/));
  for (const field of ['width', 'height', 'rotation']) await t.test(field, () => rejectMutation(d => { d.paper.pages[0][field] += 1; }, new RegExp('PDF page geometry mismatch ' + field)));
});

test('independent figure ledger must be complete and bind source plus inventory', async t => {
  await t.test('missing', () => rejectMutation(d => { delete d.figureLedger; }, /expected figure ledger missing\/incomplete/));
  await t.test('not complete', () => rejectMutation(d => { d.figureLedger.figureLedgerComplete = false; }, /expected figure ledger missing\/incomplete/));
  for (const field of ['sourceSha256', 'inventorySha256']) await t.test(field, () => rejectMutation(d => { d.figureLedger[field] = hash('unrelated evidence'); }, /figure ledger does not bind the actual PDF inventory/));
});

test('figure counts cannot replace exact independent expected membership', async t => {
  await t.test('same count, substituted ID', () => rejectMutation(d => { d.paper.figures[0].figureId = 'substitute'; }, /figures do not match independent PDF figure ledger/));
  await t.test('missing figure', () => rejectMutation(d => { d.paper.figures = []; }, /figures do not match independent PDF figure ledger/));
  await t.test('duplicate independent ID', () => rejectMutation(d => d.figureLedger.figures.push(clone(d.figureLedger.figures[0])), /Duplicate independent figure identity/));
});

test('figure source page, crop, proof and caption membership match the ledger', async t => {
  await t.test('wrong source page', () => rejectMutation(d => { d.paper.figures[0].sourcePageId = 'source-p1'; }, /Figure source page differs/));
  await t.test('wrong crop', () => rejectMutation(d => { d.paper.figures[0].crop[2] += 1; }, /Figure crop differs/));
  await t.test('missing source proof', () => rejectMutation(d => { delete d.figureLedger.figures[0].sourceEvidence; }, /figure source\/crop proof missing/));
  await t.test('wrong caption', () => rejectMutation(d => { d.paper.figures[0].captionBlockIds = ['body-a']; }, /Caption membership differs/));
});

test('every source page has one complete graphic inventory and review', async t => {
  await t.test('missing page ID', () => rejectMutation(d => { delete d.inventory.pages[0].pageId; }, /page|identity/i));
  for (const field of ['images', 'drawings']) await t.test('missing ' + field, () => rejectMutation(d => { delete d.inventory.pages[0][field]; }, /graphic|inventory|images|drawings/i));
  await t.test('missing page reviews', () => rejectMutation(d => { delete d.figureLedger.pageReviews; }, /page|review/i));
  await t.test('unreviewed page', () => rejectMutation(d => { d.figureLedger.pageReviews.pop(); }, /page|review/i));
  await t.test('duplicate page review', () => rejectMutation(d => { d.figureLedger.pageReviews.push(clone(d.figureLedger.pageReviews[0])); }, /page|review/i));
  await t.test('review status pending', () => rejectMutation(d => { d.figureLedger.pageReviews[0].status = 'pending'; }, /review|pass/i));
  await t.test('page review lacks evidence', () => rejectMutation(d => { d.figureLedger.pageReviews[0].evidence = ' '; }, /review|evidence/i));
});

test('each independent graphic region is reviewed exactly once', async t => {
  await t.test('missing region classification', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics.pop(); }, /graphic|region|coverage/i));
  await t.test('duplicate region classification', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics.push(clone(d.figureLedger.pageReviews[1].graphics[0])); }, /graphic|region|duplicat/i));
  await t.test('unknown region', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[1].regionIds = ['invented-region']; }, /graphic|region/i));
  await t.test('duplicate inventory identity', () => rejectMutation(d => { d.inventory.pages[1].drawings[0].regionId = 'graphic-figure'; }, /graphic|region|duplicat/i));
  await t.test('empty region list', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[0].regionIds = []; }, /graphic|region/i));
  await t.test('unapproved classification', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[1].decision = 'ignored'; }, /graphic|decision|classification/i));
  await t.test('classification without evidence', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[1].evidence = ''; }, /graphic|evidence/i));
});

test('a figure is justified by a figure decision on its original source page', async t => {
  await t.test('figure mislabeled as table', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[0].decision = 'table'; }, /figure|classification|decision/i));
  await t.test('figure decision omits target', () => rejectMutation(d => { delete d.figureLedger.pageReviews[1].graphics[0].figureIds; }, /figure/i));
  await t.test('unknown target', () => rejectMutation(d => { d.figureLedger.pageReviews[1].graphics[0].figureIds = ['invented-figure']; }, /figure/i));
  await t.test('only another page claims the figure', () => rejectMutation(d => {
    const p2 = d.figureLedger.pageReviews[1].graphics[0]; p2.decision = 'source-only'; delete p2.figureIds;
    Object.assign(d.figureLedger.pageReviews[0].graphics[0], { decision: 'figure', figureIds: ['figure-a'] });
  }, /figure|source page/i));
});

test('figure caption proof cannot be omitted or assigned to a non-caption block', async t => {
  for (const field of ['captionEvidence', 'captionGlyphRanges', 'captionBlockMappings']) await t.test('missing ' + field, () => rejectMutation(d => { delete d.figureLedger.figures[0][field]; }, /caption|mapping/i));
  await t.test('empty caption evidence', () => rejectMutation(d => { d.figureLedger.figures[0].captionEvidence = []; }, /caption/i));
  await t.test('missing caption source review', () => rejectMutation(d => { d.figureLedger.figures[0].captionEvidence[0].sourceEvidence = ' '; }, /caption|evidence/i));
  await t.test('wrong canonical kind', () => rejectMutation(d => { d.paper.blocks[1].kind = 'body'; }, /caption/i));
});

test('caption mappings bind original identities to exact canonical UTF-16 slices', async t => {
  await t.test('wrong original block', () => rejectMutation(d => { d.figureLedger.figures[0].captionBlockMappings[0].originalBlockId = 'invented-original'; }, /caption|mapping/i));
  await t.test('wrong canonical block', () => rejectMutation(d => { d.figureLedger.figures[0].captionBlockMappings[0].canonicalBlockId = 'body-a'; }, /caption|mapping/i));
  await t.test('hash changed without text change', () => rejectMutation(d => { d.figureLedger.figures[0].captionEvidence[0].enHash = hash('CE'); }, /caption|hash|slice/i));
  await t.test('mapping starts late', () => rejectMutation(d => { d.figureLedger.figures[0].captionBlockMappings[0].start = 1; }, /caption|mapping|hash|slice/i));
  await t.test('mapping extends past canonical text', () => rejectMutation(d => { d.figureLedger.figures[0].captionBlockMappings[0].end = 3; }, /caption|mapping|range/i));
  await t.test('duplicate mapping', () => rejectMutation(d => { d.figureLedger.figures[0].captionBlockMappings.push(clone(d.figureLedger.figures[0].captionBlockMappings[0])); }, /caption|mapping|duplicat/i));
});

test('caption evidence proves source bounding boxes and complete glyph coverage', async t => {
  await t.test('wrong source bounding box', () => rejectMutation(d => {
    d.figureLedger.figures[0].captionEvidence[0].sourceSpans[0].bbox[0] = 0;
    d.figureLedger.figures[0].captionGlyphRanges[0].bbox[0] = 0;
  }, /caption|bbox|source/i));
  await t.test('reviewed text edit cannot borrow glyphs outside final caption source spans', () => rejectMutation(d => {
    const figure = d.figureLedger.figures[0], borrowed = { pageId: 'source-p1', glyphStart: 2, glyphEnd: 3, bbox: [10, 2, 14, 12] };
    figure.captionEvidence[0].sourceSpans = [borrowed];
    figure.captionGlyphRanges = [{ blockId: 'caption-original', canonicalBlockId: 'caption-b', ...borrowed }];
    d.paper.sourceEdits = [{ blockId: 'caption-original', before: 'B', after: 'CD', sourceEvidence: 'Self-authored reviewed text substitution does not permit source relocation.' }];
  }, /borrows glyphs outside its canonical caption/i));
  await t.test('partial caption source glyphs', () => rejectMutation(d => {
    const figure = d.figureLedger.figures[0];
    Object.assign(figure.captionEvidence[0].sourceSpans[0], { glyphEnd: 1, bbox: [2, 3, 6, 12] });
    Object.assign(figure.captionGlyphRanges[0], { glyphEnd: 1, bbox: [2, 3, 6, 12] });
    figure.captionEvidence[0].enHash = hash('C'); figure.captionBlockMappings[0].end = 1;
  }, /Canonical caption source glyph coverage must be exactly once/));
  await t.test('flattened ranges disagree with original evidence', () => rejectMutation(d => { d.figureLedger.figures[0].captionGlyphRanges[0].glyphEnd = 1; }, /caption|range|flatten/i));
  await t.test('flattened original identity changed', () => rejectMutation(d => { d.figureLedger.figures[0].captionGlyphRanges[0].blockId = 'unrelated-original'; }, /caption|range|flatten/i));
  await t.test('source glyph assigned twice in one figure proof', () => rejectMutation(d => {
    const figure = splitCaptionProof(d), duplicate = clone(figure.captionEvidence[0].sourceSpans[0]);
    figure.captionEvidence[0].sourceSpans.push(duplicate);
    figure.captionGlyphRanges.splice(1, 0, { blockId: 'original-C', canonicalBlockId: 'caption-b', ...duplicate });
  }, /caption|glyph|duplicat|coverage/i));
});

test('multiple original caption fragments may map to one complete canonical caption', () => {
  const data = fixture(); splitCaptionProof(data);
  const before = clone(data);
  assert.equal(auditSource(data).figureCount, 1);
  assert.deepEqual(data, before);
});

test('merged caption mapping gaps are limited to whitespace joiners', () => {
  const valid = fixture(), figure = splitCaptionProof(valid);
  valid.paper.blocks[1].en = 'C D'; valid.paper.blocks[1].enHash = hash('C D');
  Object.assign(figure.captionBlockMappings[1], { start: 2, end: 3 });
  assert.equal(auditSource(valid).figureCount, 1);
  const invalid = clone(valid);
  invalid.paper.blocks[1].en = 'CXD'; invalid.paper.blocks[1].enHash = hash('CXD');
  assert.throws(() => auditSource(invalid), /caption|mapping|gap|unmapped/i);
});

test('merged caption proofs reject a missing original and reversed text mappings', async t => {
  await t.test('missing original fragment', () => rejectMutation(d => {
    const figure = splitCaptionProof(d); figure.captionEvidence.pop(); figure.captionGlyphRanges.pop(); figure.captionBlockMappings.pop();
  }, /caption|coverage|mapping/i));
  await t.test('same original count but wrong slice mapping', () => rejectMutation(d => {
    const figure = splitCaptionProof(d);
    Object.assign(figure.captionBlockMappings[0], { start: 1, end: 2 });
    Object.assign(figure.captionBlockMappings[1], { start: 0, end: 1 });
  }, /caption|hash|slice/i));
});

test('equal caption glyph unions do not conceal swapped original source text', () => rejectMutation(d => {
  const figure = splitCaptionProof(d);
  [figure.captionEvidence[0].sourceSpans, figure.captionEvidence[1].sourceSpans] =
    [figure.captionEvidence[1].sourceSpans, figure.captionEvidence[0].sourceSpans];
  // Keep the flattened ledger consistent with the swapped proofs. Counts, source
  // coverage, bounding boxes and hashes of the canonical slices still agree.
  figure.captionGlyphRanges = [
    { blockId: 'original-C', canonicalBlockId: 'caption-b', pageId: 'source-p2', glyphStart: 1, glyphEnd: 2, bbox: [6, 3, 10, 12] },
    { blockId: 'original-D', canonicalBlockId: 'caption-b', pageId: 'source-p2', glyphStart: 0, glyphEnd: 1, bbox: [2, 3, 6, 12] }
  ];
}, /Caption source glyph text differs/));

function reviewedCaptionCorrection(blockId = 'original-C') {
  const data = fixture(), figure = splitCaptionProof(data);
  data.paper.blocks[1].en = 'GD'; data.paper.blocks[1].enHash = hash('GD');
  figure.captionEvidence[0].enHash = hash('G');
  data.paper.sourceEdits = [{ blockId, before: 'C', after: 'G',
    sourceEvidence: 'Self-authored reviewer-approved C/G transcription correction.' }];
  return data;
}

test('an exact documented source edit may justify an original or canonical caption correction', () => {
  for (const blockId of ['original-C', 'caption-b']) {
    const data = reviewedCaptionCorrection(blockId);
    assert.equal(auditSource(data).figureReview.captions[0].glyphCount, 2);
  }
});

test('merged caption corrections retain their exact original source evidence recursively', () => {
  const data = reviewedCaptionCorrection(), originals = clone(data.paper.sourceEdits);
  data.paper.sourceEdits = [{ blockId: 'caption-b', before: 'CD', after: 'GD', sourceEvidence: 'Reviewed group source repair', originalSourceEdits: [{ blockId: 'earlier-group', originalSourceEdits: originals }] }];
  assert.equal(auditSource(data).figureReview.captions[0].glyphCount, 2);
  data.paper.sourceEdits[0].originalSourceEdits[0].originalSourceEdits[0].after = 'wrong';
  assert.throws(() => auditSource(data), /Caption source glyph text differs/);
});

function embeddedFixture() {
  const png = Buffer.from('self-authored distinct crop bytes'), raster = Buffer.from('self-authored full page raster bytes');
  const data = fixture(), portable = clone(data.paper), uri = bytes => 'data:image/png;base64,' + bytes.toString('base64');
  portable.figures[0].asset = uri(png); portable.figures[0].assetRef = data.paper.figures[0].assetRef = 'figures/figure-a.png';
  for (let n = 0; n < portable.pages.length; n++) { portable.pages[n].asset = uri(raster); portable.pages[n].assetRef = data.paper.pages[n].assetRef = 'pages/' + n + '.png'; data.inventory.pages[n].raster = { sha256: hash(raster) }; }
  data.figureLedger.figures[0].assetSha256 = hash(png); return { ...data, portable };
}

test('embedded figures and page rasters match independent byte hashes with canonical metadata', () => {
  const d = embeddedFixture(), result = auditEmbeddedAssets(d.paper, d.portable, d.inventory, d.figureLedger);
  assert.equal(result.figures.length, 1); assert.equal(result.figures[0].status, 'verified'); assert.equal(result.allPageRastersVerified, true);
});

test('same metadata cannot hide substituted figure or source-page bytes', async t => {
  for (const [kind, mutate, error] of [
    ['figure', d => { d.portable.figures[0].asset = 'data:image/png;base64,' + Buffer.from('different crop bytes').toString('base64'); }, /HTML figure bytes differ/],
    ['page', d => { d.portable.pages[0].asset = 'data:image/png;base64,' + Buffer.from('different source raster').toString('base64'); }, /HTML source page raster bytes differ/],
    ['figure asset source path', d => { d.portable.figures[0].assetRef = 'figures/foreign.png'; }, /HTML figure metadata differs/],
    ['figure crop metadata', d => { d.portable.figures[0].crop[0]++; }, /HTML figure metadata differs/],
    ['page order metadata', d => { d.portable.pages.reverse(); }, /HTML page metadata differs/]
  ]) await t.test(kind, () => { const d = embeddedFixture(); mutate(d); assert.throws(() => auditEmbeddedAssets(d.paper, d.portable, d.inventory, d.figureLedger), error); });
});

test('missing figure proof blocks and absent independent page raster remains explicitly unverified', () => {
  const d = embeddedFixture(); delete d.figureLedger.figures[0].assetSha256;
  assert.throws(() => auditEmbeddedAssets(d.paper, d.portable, d.inventory, d.figureLedger), Blocked);
  const other = embeddedFixture(); for (const page of other.inventory.pages) delete page.raster;
  const result = auditEmbeddedAssets(other.paper, other.portable, other.inventory, other.figureLedger);
  assert.equal(result.allPageRastersVerified, false); assert.ok(result.pageRasters.every(p => p.status === 'not-verified' && /no source-page raster hash/.test(p.reason)));
});

test('a source edit must name the same caption, exact before/after text and review evidence', async t => {
  const changes = {
    'no reviewed edit': d => { delete d.paper.sourceEdits; },
    'unrelated block': d => { d.paper.sourceEdits[0].blockId = 'body-a'; },
    'wrong original text': d => { d.paper.sourceEdits[0].before = 'X'; },
    'wrong corrected text': d => { d.paper.sourceEdits[0].after = 'H'; },
    'missing review evidence': d => { d.paper.sourceEdits[0].sourceEvidence = ' '; }
  };
  for (const [name, mutate] of Object.entries(changes)) await t.test(name, () => {
    const data = reviewedCaptionCorrection(); mutate(data);
    assert.throws(() => auditSource(data), /Caption source glyph text differs/);
  });
});

test('valid UTF-16 ranges preserve full astral characters and combining text', () => {
  for (const [text, start, end] of [['A😀中B', 1, 3], ['A😀中B', 0, 5], ['e\u0301中', 0, 2], ['正文', 0, 1]]) {
    assert.doesNotThrow(() => assertUTF16Range(text, start, end, 'unit'));
  }
});

test('invalid UTF-16 ranges and offsets inside surrogate pairs are rejected', async t => {
  for (const [start, end] of [[-1, 1], [0, 6], [1, 1], [3, 1], [0.5, 3], [0, NaN]]) {
    await t.test('bounds ' + start + ':' + end, () => assert.throws(() => assertUTF16Range('A😀中B', start, end, 'unit'), /invalid UTF-16 range/));
  }
  for (const [start, end] of [[2, 3], [1, 2], [0, 2]]) {
    await t.test('surrogate ' + start + ':' + end, () => assert.throws(() => assertUTF16Range('A😀中B', start, end, 'unit'), /split surrogate pair/));
  }
});

// Independent authored raster-review records precede canonical construction here.
// These are contract/tamper fixtures; the source pipeline separately exercises real
// raster-only and mixed PDFs. They are never described as real-paper source review.
function transcriptionFixture({ mixed = false, legacy = false } = {}) {
  const data = fixture(), page = data.inventory.pages[0];
  page.glyphs = mixed ? [
    { text: 'α', font: 'FixtureSymbol', size: 10, bbox: [10, 10, 16, 20] },
    { text: ' ', font: 'FixtureSymbol', size: 10, bbox: [16, 10, 20, 20] }
  ] : [];
  page.glyphCount = page.glyphs.length;
  page.raster = { path: 'authored-page-1.png', sha256: hash('independent authored raster bytes'), scale: 2, pixelWidth: 200, pixelHeight: 400 };
  data.manifest.pages[0].glyphs = clone(page.glyphs);
  const en = mixed ? 'Reviewed α activity 😀 appears once.' : 'Reviewed raster text 😀 appears once.';
  const nativeGlyphRanges = mixed ? [{ glyphStart: 0, glyphEnd: 2 }] : [];
  data.transcriptionLedger = {
    schemaVersion: 1, sourceSha256: data.sourceSha256, independentOfPaper: true,
    provenance: { input: 'source.pdf', method: 'manual-page-raster-review' },
    pages: [{ pageId: page.pageId, rasterSha256: page.raster.sha256,
      regions: [{ regionId: 'source-region-a', bbox: [0, 0, 100, 200], en, enHash: hash(en),
        sourceEvidence: 'Self-authored full source region, reviewed before canonical construction.', nativeGlyphRanges: clone(nativeGlyphRanges) }],
      review: { status: 'reviewed', reviewer: 'Self-authored contract fixture reviewer', evidence: 'Entire authored page reviewed including blank regions.',
        coverageBbox: [0, 0, 100, 200], regionIds: ['source-region-a'], nativeGlyphRanges: clone(nativeGlyphRanges) }
    }]
  };
  const visual = { pageId: page.pageId, bbox: [0, 0, 100, 200], transcription: true,
    sourceEvidence: 'Self-authored full source region, reviewed before canonical construction.' };
  if (!legacy) Object.assign(visual, { regionId: 'source-region-a', textStart: 0, textEnd: en.length });
  data.paper.blocks[0] = { ...data.paper.blocks[0], en, enHash: hash(en), sourceSpans: [
    ...(mixed ? [{ pageId: page.pageId, glyphStart: 0, glyphEnd: 2, bbox: [10, 10, 20, 20] }] : []), visual
  ] };
  return bindTranscription(data);
}
function bindTranscription(data) {
  data.inventorySha256 = hash(JSON.stringify(data.inventory));
  data.figureLedger.inventorySha256 = data.inventorySha256;
  if (data.transcriptionLedger) {
    data.transcriptionLedger.inventorySha256 = data.inventorySha256;
    data.transcriptionLedgerSha256 = hash(JSON.stringify(data.transcriptionLedger));
    data.paper.sourceTranscriptionLedgerSha256 = data.transcriptionLedgerSha256;
  }
  return data;
}
for (const mixed of [false, true]) for (const legacy of [false, true]) {
  test(`independent raster transcription supports ${mixed ? 'mixed native/visual' : 'raster-only'} ${legacy ? 'legacy' : 'explicit'} source spans`, () => {
    const data = transcriptionFixture({ mixed, legacy }), before = clone(data), report = auditSource(data);
    assert.equal(report.glyphCount, mixed ? 4 : 2, 'Native glyphs count once, visual text is not appended to glyph evidence');
    assert.equal(report.transcription.status, 'pass');
    assert.equal(report.transcription.regionCount, 1);
    assert.deepEqual(report.transcription.pageIds, ['source-p1']);
    assert.deepEqual(data, before, 'Shared audit must not normalize or mutate input to pass');
  });
}

test('transcription ledger is mandatory and its actual raw bytes must match canonical binding', () => {
  const missing = transcriptionFixture(); delete missing.transcriptionLedger;
  assert.throws(() => auditSource(missing), error => error instanceof Blocked && /independent transcription\/region audit/.test(error.message));
  const unbound = transcriptionFixture(); delete unbound.paper.sourceTranscriptionLedgerSha256;
  assert.throws(() => auditSource(unbound), /ledger SHA/);
  const altered = transcriptionFixture(); altered.transcriptionLedgerSha256 = hash('different ledger bytes');
  assert.throws(() => auditSource(altered), /ledger SHA/);
  const wrongInventory = transcriptionFixture(); wrongInventory.transcriptionLedger.inventorySha256 = hash('another inventory');
  wrongInventory.transcriptionLedgerSha256 = hash(JSON.stringify(wrongInventory.transcriptionLedger));
  wrongInventory.paper.sourceTranscriptionLedgerSha256 = wrongInventory.transcriptionLedgerSha256;
  assert.throws(() => auditSource(wrongInventory), /bind actual inventory/);
});

const transcriptionMutations = [
  ['unrelated source PDF', d => { d.transcriptionLedger.sourceSha256 = hash('another PDF'); }],
  ['paper-derived ledger', d => { d.transcriptionLedger.independentOfPaper = false; }],
  ['non-source provenance', d => { d.transcriptionLedger.provenance.input = 'paper.json'; }],
  ['unreviewed automatic OCR', d => { d.transcriptionLedger.provenance.method = 'automatic-ocr'; }],
  ['different source raster', d => { d.transcriptionLedger.pages[0].rasterSha256 = hash('other PNG'); }],
  ['missing independent raster', d => { delete d.inventory.pages[0].raster; }],
  ['malformed matching raster hashes', d => { d.inventory.pages[0].raster.sha256 = 'not-a-sha256'; d.transcriptionLedger.pages[0].rasterSha256 = 'not-a-sha256'; }],
  ['unreviewed page', d => { d.transcriptionLedger.pages[0].review.status = 'pending'; }],
  ['unnamed reviewer', d => { d.transcriptionLedger.pages[0].review.reviewer = ''; }],
  ['missing whole-page evidence', d => { d.transcriptionLedger.pages[0].review.evidence = ''; }],
  ['partial-page review', d => { d.transcriptionLedger.pages[0].review.coverageBbox = [0, 0, 100, 100]; }],
  ['missing reviewed region', d => { d.transcriptionLedger.pages[0].review.regionIds = []; }],
  ['duplicate reviewed region', d => { d.transcriptionLedger.pages[0].review.regionIds.push('source-region-a'); }],
  ['unreviewed additional region', d => { const r = clone(d.transcriptionLedger.pages[0].regions[0]); r.regionId = 'unreviewed-region'; d.transcriptionLedger.pages[0].regions.push(r); }],
  ['unknown source page', d => { d.transcriptionLedger.pages[0].pageId = 'foreign-page'; }],
  ['duplicate source page', d => { d.transcriptionLedger.pages.push(clone(d.transcriptionLedger.pages[0])); }],
  ['omitted visual source region', d => { d.paper.blocks[0].sourceSpans.pop(); }],
  ['duplicate visual source span', d => { d.paper.blocks[0].sourceSpans.push(clone(d.paper.blocks[0].sourceSpans.at(-1))); }],
  ['invented visual glyph indices', d => { Object.assign(d.paper.blocks[0].sourceSpans.at(-1), { glyphStart: 0, glyphEnd: 2 }); }],
  ['foreign region ID', d => { d.paper.blocks[0].sourceSpans.at(-1).regionId = 'foreign-region'; }],
  ['span outside reviewed region', d => { d.paper.blocks[0].sourceSpans.at(-1).bbox = [0, 0, 99, 200]; }],
  ['stale source transcription hash', d => { d.transcriptionLedger.pages[0].regions[0].enHash = hash('different text'); }],
  ['missing region source evidence', d => { d.transcriptionLedger.pages[0].regions[0].sourceEvidence = ''; }],
  ['missing span source evidence', d => { d.paper.blocks[0].sourceSpans.at(-1).sourceEvidence = ''; }],
  ['edited canonical transcription', d => { d.paper.blocks[0].en += ' inserted'; d.paper.blocks[0].enHash = hash(d.paper.blocks[0].en); }],
  ['canonical-only source edit bypass', d => { const b = d.paper.blocks[0], before = b.en; b.en += ' inserted'; b.enHash = hash(b.en); d.paper.sourceEdits = [{ blockId: b.blockId, before, after: b.en, sourceEvidence: 'Claimed review not present in independent transcription ledger.' }]; }],
  ['split surrogate UTF16 region', d => { const b = d.paper.blocks[0]; b.sourceSpans.at(-1).textEnd = b.en.indexOf('😀') + 1; }],
  ['native glyph duplicated in canonical EN', d => { d.paper.blocks[0].en = 'α ' + d.paper.blocks[0].en; d.paper.blocks[0].enHash = hash(d.paper.blocks[0].en); }],
  ['native glyph omitted from review', d => { d.transcriptionLedger.pages[0].review.nativeGlyphRanges = []; }],
  ['native glyph duplicated in review', d => { d.transcriptionLedger.pages[0].review.nativeGlyphRanges.push({ glyphStart: 0, glyphEnd: 1 }); }],
  ['native glyph removed from canonical coverage', d => { d.paper.blocks[0].sourceSpans.shift(); }],
  ['native glyph duplicated in canonical coverage', d => { d.paper.blocks[0].sourceSpans.unshift(clone(d.paper.blocks[0].sourceSpans[0])); }]
];
for (const [name, mutate] of transcriptionMutations) test('independent transcription rejects ' + name, () => {
  const data = transcriptionFixture({ mixed: true }); mutate(data); bindTranscription(data);
  assert.throws(() => auditSource(data), /transcription|source|raster|region|glyph|review|canonical|coverage/i);
});

test('legacy transcription with repeated ambiguous text requires an explicit source mapping', () => {
  const data = transcriptionFixture({ legacy: true }), block = data.paper.blocks[0];
  block.en += ' ' + block.en; block.enHash = hash(block.en);
  assert.throws(() => auditSource(data), /transcription|ambiguous|region|canonical/i);
});
