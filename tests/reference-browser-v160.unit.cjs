#!/usr/bin/env node
'use strict';
// Self-authored source evidence only: no real PDF, model, browser or network.
// Run: node --test tests/reference-browser-v160.unit.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { verifyReferenceLedger, verifySourceEvidence, representatives } = require('./reference-links-browser.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const sourceSha256 = hash('Self-authored reference source unit fixture');
  const en = 'Alpha [1]. Beta [1–3]. Gamma [1,3].', zh = '甲 [1]。乙 [1–3]。丙 [1,3]。';
  const second = '1. One.\n2. Two.\n3. Three.\nCaption 2.';
  const page = (number, text) => ({ number, pageId: 'p' + number,
    glyphs: Array.from(text, (text, n) => ({ text, font: 'SelfAuthored', size: 10, bbox: [n, 0, n + 1, 10] })) });
  const manifest = { sourceSha256, pages: [page(1, en), page(2, second)] };
  const span = (pageId, start, end) => ({ pageId, glyphStart: start, glyphEnd: end, bbox: [start, 0, end, 10] });
  const source = (role, pageId, start, exactText) => ({ sourceSha256, role, verification: 'glyph-map',
    glyphRanges: [span(pageId, start, start + exactText.length)], exactText,
    ...(role === 'inline-citation' ? { classification: 'bibliographic-citation' } : {}) });
  const block = (blockId, kind, en, zh, sourceSpans) => ({ blockId, kind, en, zh,
    enHash: hash(en), zhHash: hash(zh), sourceSpans });
  const blocks = [block('body', 'body', en, zh, [span('p1', 0, en.length)])];
  const targets = [], expectedTargets = [], candidates = [];
  for (const [number, text] of [[1, '1. One.'], [2, '2. Two.'], [3, '3. Three.']]) {
    const start = second.indexOf(text), blockId = 'ref-' + number;
    blocks.push(block(blockId, 'reference', text, text, [span('p2', start, start + text.length)]));
    const sourceEvidence = source('bibliography-prefix', 'p2', start, number + '.');
    const expected = { number, sourceCandidateId: 'target-' + number, ...clone(sourceEvidence) };
    targets.push({ number, blockId, sourceEvidence }); expectedTargets.push(expected); candidates.push(clone(expected));
  }
  const caption = 'Caption 2.', captionZh = '图注 2。', captionStart = second.indexOf(caption);
  blocks.push(block('caption', 'caption', caption, captionZh, [span('p2', captionStart, captionStart + caption.length)]));
  const citations = [], expectedCitations = [], formatting = [];
  function addCitation(name, blockId, exactText, numbers, superscript = false) {
    const b = blocks.find(b => b.blockId === blockId), start = b.en.indexOf(exactText);
    const sourceEvidence = source('inline-citation', blockId === 'body' ? 'p1' : 'p2', start + (blockId === 'body' ? 0 : captionStart), exactText);
    const expected = { sourceCandidateId: 'inline-' + name, numbers: [...numbers], ...clone(sourceEvidence) };
    expectedCitations.push(expected); candidates.push(clone(expected));
    const english = { id: name + '-en', blockId, language: 'en', start, end: start + exactText.length, exactText, numbers: [...numbers], sourceEvidence };
    const zhStart = b.zh.indexOf(exactText);
    const chinese = { id: name + '-zh', blockId, language: 'zh', start: zhStart, end: zhStart + exactText.length, exactText,
      numbers: [...numbers], sourceEnCitationId: english.id,
      sourceEvidence: { sourceSha256, role: 'translation-citation', verification: 'paired-source', reviewNote: 'Self-authored translation preserves this citation.' } };
    citations.push(english, chinese);
    if (superscript) for (const c of [english, chinese]) formatting.push({ blockId, language: c.language, kind: 'sup', start: c.start, end: c.end });
  }
  addCitation('single', 'body', '[1]', [1]);
  addCitation('range', 'body', '[1–3]', [1, 2, 3]);
  addCitation('multiple', 'body', '[1,3]', [1, 3]);
  addCitation('caption', 'caption', '2', [2], true);
  // A reviewed numeric token can be excluded; its exclusion must have a reason.
  candidates.push({ sourceCandidateId: 'excluded-word', ...source('inline-citation', 'p1', 0, 'Alpha') });
  const candidateDocument = { schemaVersion: 1, sourceSha256, candidates };
  const inventory = { sourceSha256, pages: [{ number: 1 }, { number: 2 }] };
  const inventorySha256 = hash(JSON.stringify(inventory)), candidatesSha256 = hash(JSON.stringify(candidateDocument));
  return {
    paper: { sourceSha256, blocks, referenceTargets: targets, referenceCitations: citations, formatting },
    manifest, inventory, inventorySha256, candidates: candidateDocument, candidatesSha256,
    ledger: { schemaVersion: 1, sourceSha256, inventorySha256, referenceCandidatesSha256: candidatesSha256,
      referenceLedgerComplete: true, selfAuthored: true, realResearch: false, reviewedPageNumbers: [1, 2],
      expectedTargets, expectedCitations, candidateDecisions: candidates.map(c => ({ sourceCandidateId: c.sourceCandidateId,
        status: c.sourceCandidateId === 'excluded-word' ? 'excluded' : 'approved',
        reason: c.sourceCandidateId === 'excluded-word' ? 'A word, not a bibliography citation.' : 'Independently reviewed self-authored source span.' })) },
    audit: { status: 'pass', errors: [] }, development: true
  };
}
function reject(mutate, expected) { const data = fixture(); mutate(data); assert.throws(() => verifyReferenceLedger(data), expected); }
function citation(data, id = 'single-en') { return data.paper.referenceCitations.find(c => c.id === id); }
function evidence(data) { return citation(data).sourceEvidence; }

test('complete independently approved reference ledger passes without mutating evidence', () => {
  const data = fixture(), before = clone(data), result = verifyReferenceLedger(data);
  assert.deepEqual(result, { targets: 3, englishCitations: 4, translatedCitations: 4, allSourceCandidates: 8,
    reviewedPages: [1, 2], excludedCandidates: 1, developmentOnly: true });
  assert.deepEqual(data, before);
});

test('self-authored evidence cannot count as a cold real-paper acceptance', () => {
  reject(d => { d.development = false; }, /Synthetic fixture cannot count as cold real-paper acceptance/);
  reject(d => { delete d.ledger.selfAuthored; }, /Development flag requires explicitly self-authored fixture ledger/);
});

test('validator pass and zero errors are prerequisites', async t => {
  await t.test('failed', () => reject(d => { d.audit.status = 'fail'; }, /validator has not passed/));
  await t.test('errors despite pass', () => reject(d => { d.audit.errors.push('source mismatch'); }, /validator has not passed/));
});

test('ledger and candidate document bind source, inventory and candidate hashes', async t => {
  await t.test('candidate source', () => reject(d => { d.candidates.sourceSha256 = hash('other'); }, /candidate source mismatch/));
  for (const field of ['sourceSha256', 'inventorySha256', 'referenceCandidatesSha256']) await t.test(field, () => reject(d => { d.ledger[field] = hash('other'); }, /ledger does not bind independent source evidence/));
});

test('semantic source review must cover every original page', async t => {
  await t.test('incomplete', () => reject(d => { d.ledger.referenceLedgerComplete = false; }, /semantic source review incomplete/));
  for (const pages of [[1], [2], [1, 3], [1, 2, 3]]) await t.test(pages.join(','), () => reject(d => { d.ledger.reviewedPageNumbers = pages; }, /does not cover every PDF page/));
});

test('unresolved, unexplained, missing and duplicate source candidates are rejected', async t => {
  await t.test('unresolved', () => reject(d => { d.ledger.candidateDecisions[0].status = 'pending'; }, /Unresolved\/unexplained original-PDF citation candidate/));
  await t.test('unexplained', () => reject(d => { d.ledger.candidateDecisions[0].reason = ' '; }, /Unresolved\/unexplained original-PDF citation candidate/));
  await t.test('missing decision', () => reject(d => { d.ledger.candidateDecisions.pop(); }, /Candidate review missing\/duplicate\/extra decisions/));
  await t.test('duplicate decision', () => reject(d => { d.ledger.candidateDecisions.push(clone(d.ledger.candidateDecisions[0])); }, /Candidate review missing\/duplicate\/extra decisions/));
  await t.test('approved candidate omitted', () => reject(d => { d.ledger.candidateDecisions.at(-1).status = 'approved'; }, /Approved source candidate absent from expected ledger/));
});

test('equal target counts cannot conceal substituted bibliography membership', () => {
  reject(d => { d.paper.referenceTargets[2].number = 4; }, /Bibliography membership differs from source ledger/);
  reject(d => { d.paper.referenceTargets.pop(); }, /Bibliography membership differs from source ledger/);
});

test('a bibliography target must be a reference block with its own source glyphs', async t => {
  await t.test('wrong block kind', () => reject(d => { d.paper.blocks.find(b => b.blockId === 'ref-1').kind = 'body'; }, /not actual bibliography block/));
  await t.test('borrowed prefix from another reference', () => reject(d => { d.paper.blocks.find(b => b.blockId === 'ref-1').sourceSpans = clone(d.paper.blocks.find(b => b.blockId === 'ref-2').sourceSpans); }, /belong|source block|source span|provenance/i));
  await t.test('substituted independently approved prefix', () => reject(d => { d.paper.referenceTargets[0].sourceEvidence = clone(d.paper.referenceTargets[1].sourceEvidence); }, /belong|source block|source span|provenance|source-ledger approved/i));
});

test('source-approved English citation count, ranges and ordered targets remain exact', async t => {
  await t.test('omitted English', () => reject(d => { d.paper.referenceCitations = d.paper.referenceCitations.filter(c => c.id !== 'single-en'); }, /Missing\/extra source-approved English citation spans/));
  await t.test('omitted ledger citation', () => reject(d => { d.ledger.expectedCitations.pop(); }, /Missing\/extra source-approved English citation spans/));
  await t.test('wrong range expansion', () => reject(d => { citation(d, 'range-en').numbers = [1, 3]; }, /lexical number order\/range differs/));
  await t.test('wrong number order', () => reject(d => { citation(d, 'multiple-en').numbers.reverse(); }, /lexical number order\/range differs/));
  await t.test('missing target', () => reject(d => { citation(d).numbers = [9]; }, /missing\/ambiguous bibliography number/));
  await t.test('unclassified number', () => reject(d => { delete evidence(d).classification; }, /lacks bibliography classification/));
});

test('inline source evidence cannot be borrowed from a different canonical block', () => reject(d => {
  d.paper.blocks.find(b => b.blockId === 'body').sourceSpans = clone(d.paper.blocks.find(b => b.blockId === 'caption').sourceSpans);
}, /belong|source block|source span|provenance/i));

test('canonical UTF-16 text and independent source text are both checked', async t => {
  await t.test('canonical citation text changed', () => reject(d => { citation(d).exactText = '[2]'; }, /canonical UTF-16 identity differs/));
  await t.test('independent glyph text changed with unchanged count', () => reject(d => {
    d.manifest.pages[0].glyphs[evidence(d).glyphRanges[0].glyphStart].text = '{';
  }, /evidence text differs from actual independent source glyphs/));
  await t.test('evidence text changed', () => reject(d => { evidence(d).exactText = '[2]'; }, /evidence text differs from actual independent source glyphs/));
});

test('translated citations require exactly one approved English pairing', async t => {
  await t.test('unknown pair', () => reject(d => { citation(d, 'single-zh').sourceEnCitationId = 'absent'; }, /Translated citation lacks approved English pairing/));
  await t.test('different targets', () => reject(d => { citation(d, 'single-zh').numbers = [2]; }, /Translated citation target numbers differ/));
  await t.test('missing pairing review', () => reject(d => { citation(d, 'single-zh').sourceEvidence.reviewNote = ''; }, /Translated citation pairing proof missing/));
  await t.test('missing translation', () => reject(d => { d.paper.referenceCitations = d.paper.referenceCitations.filter(c => c.id !== 'single-zh'); }, /exactly one|one-to-one|one Chinese|one translated/i));
  await t.test('two translations assigned to one English citation', () => reject(d => {
    // Keep unique canonical ranges and valid target lists, but steal the pairing.
    citation(d, 'range-zh').sourceEnCitationId = 'single-en';
    citation(d, 'range-zh').numbers = [1];
  }, /exactly one|one-to-one|one Chinese|one translated/i));
});

test('source evidence validates exact text, intervals, roles and reviewed reasons', async t => {
  const run = (mutate, expected) => {
    const d = fixture(), e = clone(evidence(d)); mutate(e, d);
    assert.throws(() => verifySourceEvidence(d.paper, d.manifest, e, 'inline-citation'), expected);
  };
  await t.test('source SHA', () => run(e => { e.sourceSha256 = hash('other'); }, /source identity\/role missing/));
  await t.test('wrong role', () => run(e => { e.role = 'bibliography-prefix'; }, /source identity\/role missing/));
  await t.test('missing verification', () => run(e => { e.verification = 'assumed'; }, /source verification missing/));
  await t.test('missing ranges', () => run(e => { e.glyphRanges = []; }, /glyph evidence missing/));
  await t.test('unknown page', () => run(e => { e.glyphRanges[0].pageId = 'none'; }, /Citation page absent/));
  await t.test('past end', () => run(e => { e.glyphRanges[0].glyphEnd = 999; }, /glyph interval invalid/));
  await t.test('repeated glyph', () => run(e => { e.glyphRanges.push(clone(e.glyphRanges[0])); }, /repeats source glyph/));
  await t.test('reviewed without reason', () => run(e => { e.verification = 'reviewed-source'; }, /lacks review reason/));
  const d = fixture(), e = clone(evidence(d)); e.verification = 'reviewed-source'; e.reviewNote = 'Manually checked authored source.';
  assert.equal(verifySourceEvidence(d.paper, d.manifest, e, 'inline-citation'), verifySourceEvidence(d.paper, d.manifest, evidence(d), 'inline-citation'));
});

test('source evidence can join non-overlapping ranges without losing order', () => {
  const d = fixture(), e = clone(evidence(d)), r = e.glyphRanges[0];
  e.glyphRanges = [{ ...r, glyphEnd: r.glyphStart + 1 }, { ...r, glyphStart: r.glyphStart + 1 }];
  assert.doesNotThrow(() => verifySourceEvidence(d.paper, d.manifest, e, 'inline-citation', d.paper.blocks[0]));
  e.glyphRanges.reverse();
  assert.throws(() => verifySourceEvidence(d.paper, d.manifest, e, 'inline-citation'), /evidence text differs/);
});

test('representatives cover bilingual single, range, multiple, superscript and caption cases', () => {
  const data = fixture(), result = representatives(data.paper);
  assert.deepEqual(result.absent, []);
  assert.equal(result.result.length, 10);
  for (const language of ['en', 'zh']) for (const [category, name] of Object.entries({ single: 'single', range: 'range', multiple: 'multiple', superscript: 'caption', caption: 'caption' })) {
    assert.equal(result.result.find(r => r.language === language && r.category === category).citation.id, name + '-' + language);
  }
});

test('representatives disclose absent patterns rather than inventing article coverage', () => {
  const data = fixture();
  data.paper.referenceCitations = data.paper.referenceCitations.filter(c => c.id.startsWith('single-'));
  data.paper.formatting = [];
  const result = representatives(data.paper);
  assert.deepEqual(result.result.map(r => [r.language, r.category]), [['en', 'single'], ['zh', 'single']]);
  assert.deepEqual(result.absent.map(r => [r.language, r.category]), ['en', 'zh'].flatMap(language => ['range', 'multiple', 'superscript', 'caption'].map(category => [language, category])));
  assert.ok(result.absent.every(r => /No such source-approved pattern/.test(r.reason)));
});
