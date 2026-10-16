#!/usr/bin/env node
/* Real-paper acceptance, independent of article title, IDs, page count or figure count.
 * No browser starts on import or --preflight-only. Product actions use trusted browser
 * input. evaluate() reads DOM/state/geometry; init scripts only observe input or model
 * a named storage failure inside a disposable context. Never attaches to user Chrome.
 *
 * --fixture READER.html --paper paper.json --source source.pdf
 * --manifest source-manifest.json --inventory independent-source-inventory.json
 * --figure-ledger source-figure-ledger.json
 * [--transcription-ledger independent-transcription-ledger.json] [--python EXISTING_PYTHON]
 * --reference-audit independent-reference-audit.json --out EVIDENCE
 * [--chrome INSTALLED_CHROME] [--playwright MODULE] [--only gate,gate]
 * [--legacy-evidence SEPARATE_REGRESSION_REPORT] [--preflight-only true]
 * Independent inventory/audit are prerequisite evidence, not generated from paper.json.
 */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = (condition, message) => { if (!condition) throw Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const id = value => '[id=' + JSON.stringify(value) + ']';
const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
const GATES = [
  'clean-reading-ui-and-qa-boundary', 'continuous-offline-original-pdf',
  'five-color-floating-highlights-and-portable-notes', 'legacy-v1-note-idmap-migration',
  'hierarchical-bilingual-toc', 'metadata-two-column-source-preservation',
  'all-figures-contain-complete-responsive', 'contain-zoom-pan-reset',
  'canonical-bilingual-source-integrity', 'canonical-headings-and-green-legends',
  'navigation-and-mobile', 'draggable-three-columns', 'follow-pin-modal-and-export-names',
  'source-button-native-pdf-page-jumps', 'reading-font-size-controls-and-persistence',
  'local-bilingual-search-and-note-anchors', 'mobile-touch-selection-and-toolbar',
  'storage-failure', 'json-markdown-download-upload', 'conflict-migration'
];
class Blocked extends Error { constructor(message) { super(message); this.name = 'Blocked'; } }
function options(argv) {
  const out = {};
  for (let n = 0; n < argv.length; n += 2) {
    assert(/^--[a-z-]+$/.test(argv[n]) && argv[n + 1] !== undefined, 'Options require --name value pairs');
    out[argv[n].slice(2)] = argv[n + 1];
  }
  return out;
}
function embedded(html, script = 'paper-data') {
  const match = html.match(new RegExp('<script\\b[^>]*\\bid=["\']' + script + '["\'][^>]*>([\\s\\S]*?)<\\/script>', 'i'));
  assert(match, 'Missing embedded ' + script); return JSON.parse(match[1]);
}
function bytesFromDataURI(value) {
  assert(typeof value === 'string' && value.startsWith('data:'), 'Source asset is not embedded offline');
  const split = value.indexOf(',');
  return value.slice(0, split).includes(';base64') ? Buffer.from(value.slice(split + 1), 'base64') : Buffer.from(decodeURIComponent(value.slice(split + 1)));
}
function glyphTuple(g) { return [g.text, g.font, g.size, g.bbox]; }
function glyphDigest(glyphs) { return sha(JSON.stringify(glyphs.map(glyphTuple))); }
function exactFields(a, b, fields, label) { for (const key of fields) assert(JSON.stringify(a[key]) === JSON.stringify(b[key]), label + ': ' + key + ' differs'); }
function assertUTF16Range(text, start, end, label) {
  assert(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length, label + ': invalid UTF-16 range');
  for (const offset of [start, end]) assert(!(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])), label + ': split surrogate pair');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function same(a, b, label) { assert(JSON.stringify(stable(a)) === JSON.stringify(stable(b)), label); }
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function sourceEditsDeep(items) { return (Array.isArray(items) ? items : []).flatMap(e => e && typeof e === 'object' ? [e, ...sourceEditsDeep(e.originalSourceEdits)] : []); }
function sourceGlyphKeys(spans, pages, label) {
  assert(Array.isArray(spans) && spans.length, label + ': source spans missing');
  const keys = [];
  for (const span of spans) {
    const page = pages.get(span.pageId); assert(page, label + ': unknown source page');
    assert(Number.isInteger(span.glyphStart) && Number.isInteger(span.glyphEnd) && span.glyphStart >= 0 && span.glyphEnd > span.glyphStart && span.glyphEnd <= page.glyphs.length, label + ': invalid source glyph interval');
    const glyphs = page.glyphs.slice(span.glyphStart, span.glyphEnd), box = [Math.min(...glyphs.map(g => g.bbox[0])), Math.min(...glyphs.map(g => g.bbox[1])), Math.max(...glyphs.map(g => g.bbox[2])), Math.max(...glyphs.map(g => g.bbox[3]))];
    assert(span.bbox?.length === 4 && box.every((v, n) => Math.abs(v - span.bbox[n]) <= .01), label + ': source bbox differs from exact glyph union');
    for (let index = span.glyphStart; index < span.glyphEnd; index++) keys.push(span.pageId + ':' + index);
  }
  assert(new Set(keys).size === keys.length, label + ': repeated source glyph'); return keys;
}
function auditFigureLedger(P, M, I, L) {
  if (!Array.isArray(L.pageReviews)) throw new Blocked('Independent full-page figure review missing/incomplete');
  const pages = new Map(M.pages.map(p => [p.pageId, p])), reviews = new Map(L.pageReviews.map(p => [p.pageId, p])), coveredFigures = new Set();
  assert(reviews.size === L.pageReviews.length && reviews.size === I.pages.length, 'Independent page review coverage missing/duplicate');
  for (const page of I.pages) {
    assert(nonempty(page.pageId), 'Independent inventory pageId missing');
    if (!Array.isArray(page.images) || !Array.isArray(page.drawings)) throw new Blocked('Independent inventory graphic objects missing for ' + page.pageId);
    const regions = [...page.images, ...page.drawings], ids = regions.map(r => r.regionId), review = reviews.get(page.pageId);
    assert(ids.every(nonempty) && new Set(ids).size === ids.length, 'Independent graphic region identity missing/duplicate');
    assert(review && review.status === 'pass' && nonempty(review.evidence) && Array.isArray(review.graphics), 'Independent source page review incomplete ' + page.pageId);
    const assigned = [];
    for (const decision of review.graphics) {
      assert(['figure', 'table', 'equation', 'decoration', 'source-only'].includes(decision.decision) && nonempty(decision.evidence), 'Graphic classification lacks source review');
      assert(Array.isArray(decision.regionIds) && decision.regionIds.length && decision.regionIds.every(r => ids.includes(r)), 'Graphic review names missing/foreign source region'); assigned.push(...decision.regionIds);
      if (decision.decision === 'figure') {
        assert(Array.isArray(decision.figureIds) && decision.figureIds.length && new Set(decision.figureIds).size === decision.figureIds.length, 'Figure graphic decision has no unique figure targets');
        for (const figureId of decision.figureIds) { const figure = L.figures.find(f => f.figureId === figureId); assert(figure && figure.sourcePageNumber === page.number, 'Graphic decision figure does not belong to this source page'); coveredFigures.add(figureId); }
      } else assert(!decision.figureIds?.length, 'Non-figure graphic classification carries figure targets');
    }
    assert(assigned.length === ids.length && new Set(assigned).size === assigned.length && ids.every(r => assigned.includes(r)), 'Graphic source region coverage must be exactly once');
  }
  const captions = [];
  for (const figure of L.figures) {
    assert(coveredFigures.has(figure.figureId), 'Independent figure has no same-page graphic review');
    const evidence = figure.captionEvidence, mappings = figure.captionBlockMappings;
    assert(Array.isArray(evidence) && evidence.length && Array.isArray(mappings) && mappings.length === evidence.length, 'Independent caption evidence/mapping missing');
    assert(new Set(evidence.map(e => e.blockId)).size === evidence.length && new Set(mappings.map(m => m.originalBlockId)).size === mappings.length, 'Duplicate original caption evidence/mapping');
    const flattened = [], byCaption = new Map();
    for (const original of evidence) {
      const mapping = mappings.find(m => m.originalBlockId === original.blockId), canonical = P.blocks.find(b => b.blockId === original.canonicalBlockId);
      assert(mapping && mapping.canonicalBlockId === original.canonicalBlockId && canonical?.kind === 'caption' && figure.captionBlockIds.includes(canonical.blockId), 'Caption original/canonical mapping target mismatch');
      assertUTF16Range(canonical.en, mapping.start, mapping.end, 'Caption mapping ' + original.blockId);
      assert(original.enHash === sha(canonical.en.slice(mapping.start, mapping.end)) && nonempty(original.sourceEvidence), 'Caption source hash/review evidence mismatch');
      const keys = sourceGlyphKeys(original.sourceSpans, pages, 'Caption evidence ' + original.blockId), allowed = new Set(sourceGlyphKeys(canonical.sourceSpans, pages, 'Canonical caption ' + canonical.blockId));
      const raw = original.sourceSpans.map(s => pages.get(s.pageId).glyphs.slice(s.glyphStart, s.glyphEnd).map(g => g.text).join('')).join(''), mapped = canonical.en.slice(mapping.start, mapping.end), plain = text => text.replace(/\s+/gu, '');
      const reviewedEdit = sourceEditsDeep(P.sourceEdits).some(e => [original.blockId, canonical.blockId].includes(e.blockId) && typeof e.before === 'string' && plain(e.before) === plain(raw) && e.after === mapped && nonempty(e.sourceEvidence));
      assert(plain(raw) === plain(mapped) || reviewedEdit, 'Caption source glyph text differs from mapped canonical text without exact reviewed edit');
      assert(keys.every(k => allowed.has(k)), 'Caption evidence borrows glyphs outside its canonical caption');
      let group = byCaption.get(canonical.blockId); if (!group) byCaption.set(canonical.blockId, group = { keys: [], mappings: [], expected: [...allowed] }); group.keys.push(...keys); group.mappings.push(mapping);
      for (const span of original.sourceSpans) flattened.push({ blockId: original.blockId, canonicalBlockId: original.canonicalBlockId, ...span });
    }
    same(figure.captionGlyphRanges, flattened, 'Caption glyph range ledger differs from original reviewed evidence');
    same([...byCaption.keys()].sort(), [...figure.captionBlockIds].sort(), 'Caption source evidence does not cover all figure captions');
    for (const [blockId, group] of byCaption) {
      assert(group.keys.length === group.expected.length && new Set(group.keys).size === group.keys.length && group.expected.every(k => group.keys.includes(k)), 'Canonical caption source glyph coverage must be exactly once');
      const block = P.blocks.find(b => b.blockId === blockId); let end = 0;
      for (const mapping of group.mappings.sort((a, b) => a.start - b.start)) { assert(mapping.start >= end && /^\s*$/.test(block.en.slice(end, mapping.start)), 'Caption mappings overlap or omit non-whitespace source text'); end = mapping.end; }
      assert(/^\s*$/.test(block.en.slice(end)), 'Caption mapping omits canonical source text');
      captions.push({ figureId: figure.figureId, blockId, originalBlocks: group.mappings.map(m => m.originalBlockId), glyphCount: group.keys.length });
    }
  }
  return { reviewedPages: reviews.size, graphicFigures: coveredFigures.size, captions };
}
function auditEmbeddedAssets(P, portable, I, L) {
  const metadata = values => values.map(value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'asset')));
  same(metadata(portable.figures), metadata(P.figures), 'HTML figure metadata differs from canonical source mapping');
  same(metadata(portable.pages), metadata(P.pages), 'HTML page metadata differs from canonical source mapping');
  const figures = [], pages = [];
  for (const figure of portable.figures) {
    const expected = L.figures.find(f => f.figureId === figure.figureId);
    if (!/^[a-f0-9]{64}$/.test(expected?.assetSha256 || '')) throw new Blocked('Independent source crop asset SHA missing for ' + figure.figureId);
    const digest = sha(bytesFromDataURI(figure.asset)); assert(digest === expected.assetSha256, 'HTML figure bytes differ from independently reviewed source crop ' + figure.figureId);
    figures.push({ figureId: figure.figureId, sha256: digest, status: 'verified' });
  }
  for (const page of portable.pages) {
    const expected = I.pages.find(p => p.number === page.number);
    if (expected?.raster === undefined) { pages.push({ pageId: page.pageId, status: 'not-verified', reason: 'Independent inventory has no source-page raster hash; original PDF bytes are verified separately' }); continue; }
    assert(/^[a-f0-9]{64}$/.test(expected.raster?.sha256 || ''), 'Malformed independent source page raster hash');
    const digest = sha(bytesFromDataURI(page.asset)); assert(digest === expected.raster.sha256, 'HTML source page raster bytes differ from independent inventory ' + page.pageId);
    pages.push({ pageId: page.pageId, sha256: digest, status: 'verified' });
  }
  return { figures, pageRasters: pages, allPageRastersVerified: pages.every(p => p.status === 'verified') };
}

// Reuse the source pipeline's pure validator: one transcription contract, no PDF
// traversal or interpretation inside the browser runner. JSON travels over stdin,
// and no canonical/source data is printed on failure or changed by this bridge.
function auditTranscription({ paper, inventory, transcriptionLedger, transcriptionLedgerSha256, inventorySha256, python }) {
  if (!transcriptionLedger) throw new Blocked('Scanned source requires independent transcription/region audit ledger');
  assert(/^[a-f0-9]{64}$/.test(transcriptionLedgerSha256 || '') && paper.sourceTranscriptionLedgerSha256 === transcriptionLedgerSha256, 'Canonical transcription ledger SHA differs from independent ledger bytes');
  assert(transcriptionLedger.inventorySha256 === inventorySha256, 'Transcription ledger does not bind actual inventory bytes');
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from source_pipeline import validate_transcription_ledger',
    'data = json.load(sys.stdin)',
    'try:',
    '    result = validate_transcription_ledger(data["paper"], data["inventory"], data["ledger"])',
    'except (ValueError, KeyError, TypeError, IndexError) as error:',
    '    print(json.dumps({"status": "fail", "error": str(error)}))',
    '    sys.exit(1)',
    'print(json.dumps(result, ensure_ascii=False))'
  ].join('\n');
  const result = spawnSync(python || process.env.PYTHON_EXECUTABLE || 'python3', ['-c', script, path.resolve(__dirname, '../scripts')], {
    input: JSON.stringify({ paper, inventory, ledger: transcriptionLedger }), encoding: 'utf8',
    timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  if (result.error) throw new Blocked('Shared transcription validator unavailable: ' + result.error.message);
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Blocked('Shared transcription validator failed to return a valid report (exit ' + result.status + ')'); }
  assert(result.status === 0 && report.status === 'pass', 'Independent transcription/region audit failed: ' + (report.error || 'no passing result'));
  return report;
}

/* Exact independent source glyph identity is checked before coverage. A forged or
 * truncated extraction manifest cannot pass merely because every remaining index is
 * assigned once. Each inventory page supplies full glyph records or a digest of the
 * documented tuple serialization, captured directly from the original PDF. */
function auditSource({ paper: P, manifest: M, inventory: I, figureLedger: L, inventorySha256, sourceSha256, transcriptionLedger, transcriptionLedgerSha256, python }) {
  assert(I.schemaVersion === 1, 'Unsupported independent inventory schema');
  assert(I.independentOfPaper === true && I.provenance?.input === 'source.pdf', 'Inventory must explicitly originate from source.pdf independently of paper.json');
  assert(I.provenance?.tool && I.provenance?.version, 'Independent extractor tool/version missing');
  for (const [label, object] of [['paper', P], ['manifest', M], ['inventory', I]]) assert(object.sourceSha256 === sourceSha256, label + ' source SHA differs from actual PDF');
  assert(Number.isInteger(I.pageCount) && I.pageCount > 0 && I.pages.length === I.pageCount, 'Independent page inventory incomplete');
  assert(P.pages.length === I.pageCount && M.pages.length === I.pageCount, 'Source page count mismatch');
  assert(new Set(P.blocks.map(b => b.blockId)).size === P.blocks.length, 'Duplicate canonical block ID');
  const counts = new Map(), details = [];
  for (let index = 0; index < I.pageCount; index++) {
    const expected = I.pages[index], page = P.pages.find(p => p.number === expected.number), manifest = M.pages.find(p => p.number === expected.number);
    assert(expected.number === index + 1 && page && manifest, 'Independent page sequence mismatch');
    assert(page.pageId === manifest.pageId, 'Page identity differs across canonical data and extraction');
    const count = expected.glyphCount ?? expected.glyphs?.length;
    const digest = expected.glyphs ? glyphDigest(expected.glyphs) : expected.glyphSha256;
    assert(Number.isInteger(count) && /^[a-f0-9]{64}$/.test(digest || ''), 'Inventory lacks independent exact glyph identity for page ' + expected.number);
    assert(manifest.glyphs.length === count && glyphDigest(manifest.glyphs) === digest, 'Independent source glyph identity mismatch page ' + expected.number);
    for (const key of ['width', 'height', 'rotation']) if (expected[key] !== undefined) assert(Math.abs(page[key] - expected[key]) < 0.01, 'PDF page geometry mismatch ' + key);
    counts.set(page.pageId, new Uint16Array(count));
    details.push({ number: expected.number, pageId: page.pageId, glyphCount: count, glyphSha256: digest });
  }
  const byPage = new Map(M.pages.map(p => [p.pageId, p]));
  const hasTranscription = P.blocks.some(b => b.sourceSpans?.some(s => s.transcription));
  const transcription = hasTranscription || transcriptionLedger ? auditTranscription({ paper: P, inventory: I, transcriptionLedger, transcriptionLedgerSha256, inventorySha256, python }) : null;
  let assignments = 0;
  for (const block of P.blocks) {
    assert(block.enHash === sha(block.en) && block.zhHash === sha(block.zh || ''), 'Stale canonical text hash ' + block.blockId);
    assert(Array.isArray(block.sourceSpans) && block.sourceSpans.length, 'Unproven canonical block ' + block.blockId);
    for (const span of block.sourceSpans) {
      const coverage = counts.get(span.pageId), page = byPage.get(span.pageId);
      assert(coverage, 'Unknown source page ' + span.pageId);
      if (span.transcription) continue; // Independently validated visual region; native spans remain counted below.
      assert(Number.isInteger(span.glyphStart) && Number.isInteger(span.glyphEnd) && span.glyphStart >= 0 && span.glyphEnd > span.glyphStart && span.glyphEnd <= coverage.length, 'Invalid source glyph interval ' + block.blockId);
      for (let n = span.glyphStart; n < span.glyphEnd; n++) { coverage[n]++; assignments++; }
      const glyphs = page.glyphs.slice(span.glyphStart, span.glyphEnd);
      const box = [Math.min(...glyphs.map(g => g.bbox[0])), Math.min(...glyphs.map(g => g.bbox[1])), Math.max(...glyphs.map(g => g.bbox[2])), Math.max(...glyphs.map(g => g.bbox[3]))];
      assert(span.bbox?.length === 4 && box.every((v, n) => Math.abs(v - span.bbox[n]) <= 0.01), 'Source span bbox/glyph identity mismatch ' + block.blockId);
    }
  }
  for (const [pageId, coverage] of counts) assert([...coverage].every(n => n === 1), 'Missing or duplicated source glyph assignment ' + pageId);
  assert(L && Array.isArray(L.figures) && L.figureLedgerComplete === true, 'Independent expected figure ledger missing/incomplete');
  assert(L.sourceSha256 === sourceSha256 && L.inventorySha256 === inventorySha256, 'Independent figure ledger does not bind the actual PDF inventory');
  assert(new Set(L.figures.map(f => f.figureId)).size === L.figures.length, 'Duplicate independent figure identity');
  same(P.figures.map(f => f.figureId).sort(), L.figures.map(f => f.figureId).sort(), 'Canonical figures do not match independent PDF figure ledger');
  for (const expected of L.figures) {
    const actual = P.figures.find(f => f.figureId === expected.figureId), sourcePage = P.pages.find(p => p.pageId === actual.sourcePageId);
    assert(sourcePage?.number === expected.sourcePageNumber, 'Figure source page differs from independent ledger ' + expected.figureId);
    assert(expected.sourceEvidence && Array.isArray(expected.crop), 'Independent figure source/crop proof missing');
    assert(actual.crop.length === 4 && actual.crop.every((v, n) => Math.abs(v - expected.crop[n]) <= 0.01), 'Figure crop differs from independent source ledger ' + expected.figureId);
    if (expected.captionBlockIds) same([...actual.captionBlockIds].sort(), [...expected.captionBlockIds].sort(), 'Caption membership differs from independent ledger');
  }
  const figureReview = auditFigureLedger(P, M, I, L);
  return { sourceSha256, pageCount: I.pageCount, glyphCount: assignments, pages: details, figureCount: L.figures.length, independentTool: I.provenance, figureReview, ...(transcription ? { transcription } : {}) };
}

class Harness {
  constructor(o, suite = 'reader-generic-v160') {
    this.o = o; this.out = path.resolve(o.out || '.'); this.contexts = new Set(); this.sequence = 0;
    this.report = { schemaVersion: 1, suite, startedAt: new Date().toISOString(), modelRuntime: { status: 'unknown', reason: 'Browser evidence cannot measure inference or translation runtime' }, isolation: 'new installed Chrome process; disposable offline contexts; no user profile or existing tabs', timingScope: 'measured host wall and monotonic elapsed only; no model-runtime attribution', stages: [], checks: [], screenshots: [], inputEvents: [], errors: [], httpRequests: [], contexts: [] };
  }
  async stage(name, fn, metadata = {}) {
    const record = { name, ...metadata, startedAt: new Date().toISOString(), status: 'running' }, start = performance.now(); this.report.stages.push(record);
    try { const value = await fn(); record.status = 'pass'; return value; }
    catch (error) { record.status = 'fail'; record.error = error.message; throw error; }
    finally { record.finishedAt = new Date().toISOString(); record.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000; }
  }
  async prepare() {
    await fs.mkdir(this.out, { recursive: true });
    for (const key of ['fixture', 'paper', 'source', 'manifest', 'inventory', 'figure-ledger']) assert(this.o[key], 'Missing --' + key);
    await this.stage('read-and-hash-inputs', async () => {
      this.inputs = {};
      for (const key of ['fixture', 'paper', 'source', 'manifest', 'inventory', 'figure-ledger', 'reference-audit', 'legacy-evidence', 'transcription-ledger']) if (this.o[key]) {
        const file = path.resolve(this.o[key]), bytes = await fs.readFile(file);
        this.inputs[key] = { path: file, sha256: sha(bytes), size: bytes.length };
        if (key === 'fixture') this.html = bytes.toString('utf8');
        else if (key !== 'source') this[({ 'reference-audit': 'referenceAudit', 'legacy-evidence': 'legacyEvidence', 'figure-ledger': 'figureLedger', 'transcription-ledger': 'transcriptionLedger' })[key] || key] = JSON.parse(bytes.toString('utf8'));
      }
      this.report.inputs = this.inputs;
    });
    await this.stage('independent-source-audit', async () => {
      this.report.sourceAudit = auditSource({ paper: this.paper, manifest: this.manifest, inventory: this.inventory, figureLedger: this.figureLedger, transcriptionLedger: this.transcriptionLedger, transcriptionLedgerSha256: this.inputs['transcription-ledger']?.sha256, python: this.o.python, inventorySha256: this.inputs.inventory.sha256, sourceSha256: this.inputs.source.sha256 });
      const portable = embedded(this.html);
      for (const key of ['documentId', 'sourceSha256', 'blocks', 'sections', 'formatting', 'inlineReferences', 'idMap', 'paragraphMerges', 'referenceTargets', 'referenceCitations', 'reviewScopes', 'sourceTranscriptionLedgerSha256']) if (this.paper[key] !== undefined) same(portable[key], this.paper[key], 'HTML canonical ' + key + ' differs from audited work data');
      assert(sha(bytesFromDataURI(portable.sourcePdf)) === this.inputs.source.sha256, 'HTML embedded PDF bytes differ from actual source');
      this.report.embeddedAssets = auditEmbeddedAssets(this.paper, portable, this.inventory, this.figureLedger);
      this.embeddedPaper = portable;
      this.report.fixtureClassification = { selfAuthored: this.figureLedger.selfAuthored === true || this.paper.fixture?.selfAuthored === true, realResearch: this.figureLedger.realResearch ?? this.paper.fixture?.realResearch ?? null };
      this.report.developmentOnly = this.report.fixtureClassification.selfAuthored || this.report.fixtureClassification.realResearch === false;
      this.report.documentId = this.paper.documentId;
      this.report.nodeVersion = process.version;
      this.report.runnerSha256 = sha(await fs.readFile(__filename));
    });
    this.body = this.paper.blocks.find(b => ['body', 'methods'].includes(b.kind) && b.en.length >= 80 && b.zh?.length >= 30 && !this.paper.articleInfo?.fields.some(f => f.blockIds.includes(b.blockId)));
    assert(this.body, 'No reviewed bilingual scientific paragraph for real input tests');
    return this;
  }
  async launch() {
    const modulePath = this.o.playwright || process.env.PLAYWRIGHT_MODULE || 'playwright';
    this.browser = await this.stage('browser-launch', () => require(modulePath).chromium.launch({ headless: this.o.headed !== 'true', executablePath: this.o.chrome || process.env.CHROME_EXECUTABLE }));
    this.report.browserVersion = this.browser.version(); this.report.playwrightModule = modulePath;
  }
  async open({ file = this.inputs.fixture.path, mobile = false, fault = null } = {}) {
    const contextId = ++this.sequence, entry = { contextId, file, mobile, fault: fault?.kind || null, openedAt: new Date().toISOString() }; this.report.contexts.push(entry);
    const context = await this.stage('context-setup', () => this.browser.newContext({ offline: true, acceptDownloads: true, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}) }), { contextId });
    context._acceptanceContextId = contextId; this.contexts.add(context);
    if (fault) await context.addInitScript(({ key, fault }) => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
      if (fault.raw !== undefined) set.call(localStorage, key, fault.raw);
      window.__acceptanceStorage = { reads: 0, writes: 0, readRaw: () => get.call(localStorage, key) };
      Storage.prototype.getItem = function (k) { if (k === key) { window.__acceptanceStorage.reads++; if (fault.kind === 'read') throw new DOMException('QA read refusal', 'SecurityError'); } return get.call(this, k); };
      Storage.prototype.setItem = function (k, v) { if (k === key) { window.__acceptanceStorage.writes++; if (fault.kind === 'quota') throw new DOMException('QA quota refusal', 'QuotaExceededError'); } return set.call(this, k, v); };
    }, { key: this.notesKey(), fault });
    const p = await context.newPage(); p.setDefaultTimeout(15000); p._contextId = contextId;
    p.on('pageerror', e => this.report.errors.push({ contextId, message: e.message }));
    p.on('request', r => { if (/^https?:/.test(r.url())) this.report.httpRequests.push({ contextId, url: r.url() }); });
    await p.exposeBinding('__acceptanceInput', (_, value) => { if (this.report.inputEvents.length < 12000) this.report.inputEvents.push({ contextId, ...value }); });
    await p.addInitScript(() => {
      if (location.protocol !== 'file:') return;
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'wheel']) document.addEventListener(type, e => {
        const t = e.target instanceof Element ? e.target : null;
        window.__acceptanceInput({ type, trusted: e.isTrusted, pointerType: e.pointerType, key: e.key, targetId: t?.id, targetClass: typeof t?.className === 'string' ? t.className : '', time: performance.now() }).catch(() => {});
      }, true);
    });
    await this.stage('page-load-and-ready', async () => { await p.goto(pathToFileURL(file).href); await this.ready(p); }, { contextId });
    this.page = p; return { p, context, contextId };
  }
  async close(handle) {
    await this.stage('context-close', () => handle.context.close(), { contextId: handle.contextId });
    this.contexts.delete(handle.context); this.report.contexts.find(c => c.contextId === handle.contextId).closedAt = new Date().toISOString();
  }
  async withPage(fn, opts = {}) { const h = await this.open(opts); try { return await fn(h.p, h); } catch (error) { if (!(error instanceof Blocked)) error.acceptanceScreenshot = await this.shot(h.p, 'failure-context-' + h.contextId).catch(() => null); throw error; } finally { await this.close(h); } }
  async ready(p) { await p.waitForFunction(() => window.microPaper?.ready, null, { timeout: 45000 }); }
  notesKey() { return 'micro-paper:notes:v1:' + this.paper.documentId + ':' + this.paper.sourceSha256; }
  async shot(p, name) {
    const filename = String(this.report.screenshots.length + 1).padStart(2, '0') + '-' + name.replace(/[^\w-]/g, '-') + '.png';
    await this.stage('screenshot', () => p.screenshot({ path: path.join(this.out, filename), fullPage: false }), { nameHint: name, contextId: p._contextId });
    this.report.screenshots.push(filename); return filename;
  }
  async check(name, fn) {
    if (this.o.only && !this.o.only.split(',').includes(name)) return;
    const record = { name, status: 'running', startedAt: new Date().toISOString() }; this.report.checks.push(record); const start = performance.now();
    try { record.evidence = await fn(); record.status = 'pass'; console.log('PASS ' + name); }
    catch (e) { record.status = e instanceof Blocked ? 'blocked' : 'fail'; record.error = e.stack; record.screenshot = e.acceptanceScreenshot || null; if (!record.screenshot && this.page && !this.page.isClosed()) record.screenshot = await this.shot(this.page, name + '-failure').catch(() => null); console.error(record.status.toUpperCase() + ' ' + name + ': ' + e.message); }
    finally { record.finishedAt = new Date().toISOString(); record.elapsedMs = Math.round((performance.now() - start) * 1000) / 1000; await this.save(); }
  }
  async save() { this.report.summary = Object.fromEntries(['pass', 'fail', 'blocked'].map(s => [s, this.report.checks.filter(c => c.status === s).length])); await fs.writeFile(path.join(this.out, 'evidence.json'), JSON.stringify(this.report, null, 2)); }
  async finish() {
    for (const context of this.contexts) { await context.close(); const entry = this.report.contexts.find(c => c.contextId === context._acceptanceContextId); if (entry) entry.closedAt = new Date().toISOString(); } this.contexts.clear();
    if (this.browser) await this.stage('browser-close', () => this.browser.close());
    if (this.inputs) for (const item of Object.values(this.inputs)) assert(sha(await fs.readFile(item.path)) === item.sha256, 'Read-only input changed: ' + item.path);
    this.report.inputUnchanged = true; this.report.allCreatedContextsClosed = this.report.contexts.every(c => c.closedAt); this.report.finishedAt = new Date().toISOString(); await this.save();
  }
  async download(p, selector, filename) {
    return this.stage('download-and-save', async () => {
      const [download] = await Promise.all([p.waitForEvent('download'), p.locator(selector).click()]);
      const file = path.join(this.out, filename); await download.saveAs(file);
      return { file, suggestedFilename: download.suggestedFilename(), bytes: await fs.readFile(file) };
    }, { contextId: p._contextId, filename });
  }
  async json(p, filename) { await p.locator('button[data-view=notes]').click(); const d = await this.download(p, '#export-json', filename); return { ...d, value: JSON.parse(d.bytes.toString('utf8')) }; }
  async upload(p, value, filename) {
    const file = path.join(this.out, filename); await fs.writeFile(file, JSON.stringify(value, null, 2));
    await p.locator('button[data-view=notes]').click(); await p.locator('#import-file').setInputFiles(file); await p.locator('#import-dialog').waitFor({ state: 'visible' });
    const preview = await p.locator('#import-preview').textContent(); await p.locator('#confirm-import').click(); return preview;
  }
  envelope(annotations, extra = {}) { return { format: 'micro-paper-notes', schemaVersion: 1, documentId: this.paper.documentId, sourceSha256: this.paper.sourceSha256, contentFingerprint: this.paper.contentFingerprint, exportedAt: '2026-01-01T00:00:00.000Z', annotations, ...extra }; }
  annotation(block = this.body, language = 'en', start = 8, end = 24, color = 'yellow', suffix = 'exact') {
    const text = block[language]; assertUTF16Range(text, start, end, suffix);
    return { annotationId: 'synthetic-v160-' + suffix, blockId: block.blockId, language, start, end, quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), textHash: sha(text), color, note: 'Synthetic acceptance note ' + suffix, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'located' };
  }
}

async function rect(locator) { return locator.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }); }
async function settle(p) { await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function reader(p, language = 'both') { await p.locator('button[data-view=reader]').click(); await p.locator('button[data-language=' + language + ']').click(); await settle(p); }
function prose(block, language = 'en') { return '.prose[data-block-id=' + JSON.stringify(block.blockId || block) + '][data-language=' + language + ']'; }
async function expose(p, selector) {
  const node = p.locator(selector); await node.scrollIntoViewIfNeeded();
  for (let n = 0; n < 6; n++) {
    const b = await rect(node), t = await rect(p.locator('.toolbar')), height = p.viewportSize().height;
    if (b.y >= t.bottom + 16 && b.y < height - 50) return node;
    await p.mouse.move(Math.min(b.x + 20, p.viewportSize().width - 20), Math.max(t.bottom + 25, Math.min(height - 30, b.y + 25)));
    await p.mouse.wheel(0, b.y - (t.bottom + 50)); await p.waitForTimeout(100);
  }
  return node;
}
async function rangeGeometry(locator, start, end) {
  return locator.evaluate((e, { start, end }) => {
    const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n, offset = 0, a, b;
    while ((n = walk.nextNode())) { if (!a && start < offset + n.length) a = { n, o: start - offset }; if (end <= offset + n.length) { b = { n, o: end - offset }; break; } offset += n.length; }
    if (!a || !b) throw Error('Text range geometry missing');
    const first = document.createRange(), last = document.createRange(); first.setStart(a.n, a.o); first.setEnd(a.n, Math.min(a.n.length, a.o + 1)); last.setStart(b.n, Math.max(0, b.o - 1)); last.setEnd(b.n, b.o);
    const x = first.getBoundingClientRect(), y = last.getBoundingClientRect(), t = document.querySelector('.toolbar').getBoundingClientRect();
    return { x1: x.left + .3, y1: x.top + x.height / 2, x2: y.right - .3, y2: y.top + y.height / 2, quote: e.textContent.slice(start, end), toolbarBottom: t.bottom, height: innerHeight };
  }, { start, end });
}
async function realSelection(p, selector, start, end) {
  await p.bringToFront(); const node = await expose(p, selector);
  for (let attempt = 0; attempt < 6; attempt++) {
    const g = await rangeGeometry(node, start, end);
    if (g.y1 < g.toolbarBottom + 16 || g.y2 > g.height - 40) {
      await p.mouse.move(g.x1, Math.max(g.toolbarBottom + 30, Math.min(g.height - 30, g.y1))); await p.mouse.wheel(0, (g.y1 + g.y2) / 2 - (g.toolbarBottom + g.height) / 2); await p.waitForTimeout(100); continue;
    }
    await p.mouse.move(g.x1, g.y1); await p.mouse.down(); await p.mouse.move(g.x2, g.y2, { steps: 18 }); await p.mouse.up();
    assert(await p.evaluate(() => String(getSelection())) === g.quote, 'Native mouse selection quote mismatch'); await p.locator('#selection-tools').waitFor({ state: 'visible' }); return g.quote;
  }
  throw Error('Cannot expose requested selection range');
}
async function toolbarGeometry(p) {
  return p.locator('#selection-tools').evaluate(e => {
    const r = e.getBoundingClientRect(), t = document.querySelector('.toolbar').getBoundingClientRect(), s = getComputedStyle(e);
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, viewport: { width: innerWidth, height: innerHeight }, stickyBottom: t.bottom, background: s.backgroundColor, radius: s.borderRadius, colors: [...e.querySelectorAll('[data-highlight-color]')].map(x => x.dataset.highlightColor) };
  });
}
function assertToolbar(g) {
  same(g.colors, COLORS, 'Five swatch order changed'); assert(g.background === 'rgb(23, 79, 64)' && parseFloat(g.radius) >= 8, 'Floating toolbar visual contract changed');
  assert(g.x >= 0 && g.right <= g.viewport.width + 1 && g.y >= g.stickyBottom + 6 && g.bottom <= g.viewport.height + 1, 'Selection toolbar overlaps sticky header or viewport edge');
}
async function addNote(h, p, { block = h.body, language = 'en', start = 8, end = 24, color = 'orange', note = 'Synthetic native-input note' } = {}) {
  await reader(p, language); const quote = await realSelection(p, prose(block, language), start, end);
  await p.locator('#selection-note').click(); await p.locator('#note-text').fill(note); await p.locator('#note-color').selectOption(color); await p.locator('#note-form button[type=submit]').click(); return quote;
}
const NOTE_KEYS = ['annotationId', 'blockId', 'language', 'start', 'end', 'quote', 'prefix', 'suffix', 'textHash', 'color', 'note', 'createdAt', 'updatedAt', 'status', 'sourceSha256', 'sourceDocumentId', 'conflictOf'];
function notesStable(records) { return records.map(a => Object.fromEntries(NOTE_KEYS.filter(k => a[k] !== undefined).map(k => [k, a[k]]))).sort((a, b) => a.annotationId.localeCompare(b.annotationId)); }
async function assertMarks(p, a) {
  await reader(p, a.language); const marks = p.locator(prose(a.blockId, a.language) + ' mark[data-annotation-id=' + JSON.stringify(a.annotationId) + ']');
  const details = await marks.evaluateAll(es => ({ text: es.map(e => e.textContent).join(''), colors: [...new Set(es.map(e => e.dataset.color))], backgrounds: [...new Set(es.map(e => getComputedStyle(e).backgroundColor))] }));
  assert(details.text === a.quote && details.colors.length === 1 && details.colors[0] === a.color, 'Rendered note anchor/color mismatch'); return details;
}
async function selectFigure(p, figureId) {
  if (p.viewportSize().width <= 800 && !await p.locator('#figure-pane').evaluate(e => e.classList.contains('open'))) await p.locator('#figure-toggle').click();
  await p.locator('#figure-select').selectOption(figureId); await p.waitForFunction(() => { const e = document.querySelector('#figure-content img'); return e?.complete && e.naturalWidth > 0; }); await settle(p);
}
async function figureGeometry(p) {
  return p.locator('#figure-content img').evaluate(e => {
    const r = e.getBoundingClientRect(), viewport = e.closest('.figure-viewport'), v = viewport.getBoundingClientRect(), pane = document.querySelector('#figure-pane').getBoundingClientRect(), toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, naturalWidth: e.naturalWidth, naturalHeight: e.naturalHeight, relative: Number(e.dataset.imageScale), basis: e.dataset.imageScaleBasis, panX: Number(viewport.dataset.imagePanX), panY: Number(viewport.dataset.imagePanY), viewport: { x: v.x + viewport.clientLeft, y: v.y + viewport.clientTop, width: viewport.clientWidth, height: viewport.clientHeight }, pane: { top: pane.top, bottom: pane.bottom }, toolbarBottom: toolbar.bottom, windowHeight: innerHeight };
  });
}
function assertContain(g) {
  const tolerance = 1.8, fit = Math.min(g.viewport.width / g.naturalWidth, g.viewport.height / g.naturalHeight);
  assert(g.basis === 'contain-fit' && Math.abs(g.relative - 1) < .001, 'Contain initial/reset state missing');
  assert(Math.abs(g.width / g.naturalWidth - g.height / g.naturalHeight) < .002, 'Figure aspect ratio stretched');
  assert(Math.abs(g.width / g.naturalWidth - fit) < .003, 'Figure scale is not adaptive whole-image contain');
  assert(g.x >= g.viewport.x - tolerance && g.right <= g.viewport.x + g.viewport.width + tolerance && g.y >= Math.max(g.viewport.y, g.toolbarBottom, g.pane.top) - tolerance && g.bottom <= Math.min(g.viewport.y + g.viewport.height, g.pane.bottom, g.windowHeight) + tolerance, 'Figure clipped by image/viewport/pane');
}
async function nativePDF(p, expected) {
  const deadline = performance.now() + 20000; let last;
  while (performance.now() < deadline) {
    for (const frame of p.frames().filter(f => f.url().startsWith('chrome-extension:'))) {
      try { const input = frame.locator('viewer-page-selector input'); if (await input.count()) { last = Number(await input.inputValue()); if (last >= 1 && (expected === undefined || last === expected)) return { frame, input, actual: last }; } } catch (_) { /* viewer reattachment is transient */ }
    }
    await p.waitForTimeout(100);
  }
  throw Error('Native PDF counter unavailable/wrong: expected ' + expected + ', observed ' + last);
}

module.exports = { Harness, Blocked, GATES, COLORS, options, assert, sha, id, embedded, bytesFromDataURI, glyphDigest, auditSource, auditTranscription, auditFigureLedger, auditEmbeddedAssets, sourceGlyphKeys, same, stable, assertUTF16Range, rect, settle, reader, prose, expose, rangeGeometry, realSelection, toolbarGeometry, assertToolbar, addNote, notesStable, assertMarks, selectFigure, figureGeometry, assertContain, nativePDF };

async function clickToc(p, href) {
  if (p.viewportSize().width <= 800 && !await p.locator('#sidebar').isVisible()) await p.locator('#menu').click();
  const link = p.locator('#toc a[href=' + JSON.stringify(href) + ']').first();
  const indices = await link.evaluate(e => { const all = [...document.querySelectorAll('#toc details')], result = []; for (let node = e.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS' && !node.open) result.unshift(all.indexOf(node)); return result; });
  for (const n of indices) { const summary = p.locator('#toc details').nth(n).locator(':scope > summary'); await summary.focus(); await summary.press('Space'); }
  await link.click(); await settle(p);
  const result = await p.locator(id(href.slice(1))).evaluate(e => { const target = e.matches('.block.heading') ? e : e.querySelector('.block.heading') || e, r = target.getBoundingClientRect(); return { id: target.id, top: r.top, toolbarBottom: document.querySelector('.toolbar').getBoundingClientRect().bottom, mobileSidebarOpen: document.querySelector('#sidebar').classList.contains('open') }; });
  assert(result.top >= result.toolbarBottom + 6, 'TOC target hidden under sticky toolbar');
  if (p.viewportSize().width <= 800) assert(!result.mobileSidebarOpen, 'Mobile TOC did not close'); return result;
}
async function canonicalDOM(p) { return p.locator('.prose[data-block-id][data-language]').evaluateAll(es => es.map(e => ({ blockId: e.dataset.blockId, language: e.dataset.language, text: e.textContent, nodeCount: e.querySelectorAll('*').length }))); }
async function fontMetrics(p) {
  return p.evaluate(() => {
    const output = { values: [], width: innerWidth, scrollWidth: document.documentElement.scrollWidth, transform: getComputedStyle(document.documentElement).transform, zoom: getComputedStyle(document.documentElement).zoom };
    for (const selector of ['#article .block.body:not(.article-info-block)>.prose', '#figure-caption-content .prose']) for (const language of ['en', 'zh']) {
      const element = [...document.querySelectorAll(selector)].find(e => e.dataset.language === language && e.getClientRects().length); if (element) output.values.push({ selector, language, px: parseFloat(getComputedStyle(element).fontSize) });
    }
    return output;
  });
}
async function searchState(p) {
  return p.locator('#article-search').evaluate(e => {
    const current = CSS.highlights?.get('micro-paper-search-active'), all = CSS.highlights?.get('micro-paper-search');
    return { total: Number(e.dataset.searchCount), index: Number(e.dataset.searchIndex), mode: e.dataset.searchMode, status: document.querySelector('#search-status').textContent, active: current ? [...current].map(r => r.toString()) : [], count: all?.size, overlayRects: document.querySelectorAll('.search-range-rect').length };
  });
}
async function search(p, query) { await p.locator('#search').fill(query); await p.waitForFunction(q => document.querySelector('#search').value === q && document.querySelector('#article-search').dataset.searchIndex !== undefined, query); await settle(p); return searchState(p); }
function expectedMatches(P, query) { const term = query.trim().toLocaleLowerCase(); return P.blocks.filter(b => !['header-footer', 'figure-label'].includes(b.kind)).reduce((total, b) => total + ['en', 'zh'].reduce((n, lang) => { let count = 0, offset = 0, at; const s = (b[lang] || '').toLocaleLowerCase(); while (term && (at = s.indexOf(term, offset)) >= 0) { count++; offset = at + term.length; } return n + count; }, 0), 0); }
async function portableHTML(h, p, filename) { await p.locator('#download-html').click(); const preview = (await p.locator('#export-preview').textContent()).trim(); const d = await h.download(p, '#export-confirm', filename); assert(d.suggestedFilename === preview && preview.endsWith('.html'), 'Portable filename preview differs from download'); return d; }
function supplemental(h, gate) {
  const evidence = h.legacyEvidence, check = evidence?.checks?.find(c => c.name === gate && c.status === 'pass');
  if (!check) throw new Blocked('This paper does not contain the migration fixture; supply separate labeled synthetic regression --legacy-evidence for ' + gate);
  assert(evidence.fixtureSha256 || evidence.inputs?.fixture?.sha256, 'Supplementary regression lacks fixture SHA');
  return { supplementalRegression: true, source: h.inputs['legacy-evidence'], check, notPartOfColdPaperBenchmark: true };
}

async function runReaderGates(h) {
  const P = h.paper, check = (n, fn) => h.check(GATES[n], fn);
  await check(0, () => h.withPage(async p => {
    for (const selector of ['#reader-status', '#check-report-open', '#check-report']) assert(await p.locator(selector).count() === 0, 'Internal QA interface leaked into reader');
    assert((await p.locator('button[data-view=notes]').innerText()).trim() === '阅读笔记', 'Reading-notes entry changed');
    assert(P.qa || P.reviewScopes, 'Machine-readable QA scope missing');
    return { qaBoundary: true, screenshot: await h.shot(p, 'reader-toolbar') };
  }));
  await check(1, () => h.withPage(async p => {
    const count = h.inventory.pageCount; await p.locator('button[data-view=source]').click(); await p.locator('#source-pdf-frame').waitFor({ state: 'visible' });
    assert((await p.locator('#source-pdf-frame').getAttribute('src')).startsWith('blob:'), 'Original PDF is not offline Blob');
    const native = await nativePDF(p); await native.frame.locator('viewer-page-selector').evaluate((e, count) => new Promise((resolve, reject) => { const deadline = performance.now() + 10000, poll = () => { const text = e.shadowRoot?.textContent || e.textContent; if (new RegExp('(?:^|\\D)' + count + '(?:\\D|$)').test(text)) resolve(); else if (performance.now() > deadline) reject(Error('Native PDF total differs from independent inventory: ' + text)); else setTimeout(poll, 50); }; poll(); }), count); const total = await native.frame.locator('viewer-page-selector').evaluate(e => e.shadowRoot?.textContent || e.textContent);
    await native.input.fill('1'); await native.input.press('Enter'); await nativePDF(p, 1);
    const seen = new Set(), screenshots = [];
    for (let step = 0; step < count * 18 + 30; step++) {
      const current = Number(await native.input.inputValue()); seen.add(current);
      if ([1, Math.ceil(count / 2), count].includes(current) && !screenshots.some(x => x.page === current)) screenshots.push({ page: current, file: await h.shot(p, 'source-page-' + current) });
      if (current === count) break;
      const b = await rect(p.locator('#source-pdf-frame')); await p.mouse.move(b.x + b.width * .65, b.y + b.height * .6); await p.mouse.wheel(0, Math.min(420, b.height * .4)); await p.waitForTimeout(100);
    }
    assert(Array.from({ length: count }, (_, i) => i + 1).every(n => seen.has(n)), 'Continuous native wheel did not visit all independent source pages: ' + [...seen]);
    const downloaded = await h.download(p, '#original-pdf', 'source-original.pdf'); assert(sha(downloaded.bytes) === h.inputs.source.sha256, 'Original PDF download bytes changed');
    return { pageCount: count, nativeTotalText: total.trim(), visitedByNativeWheel: [...seen], sourceSha256: sha(downloaded.bytes), screenshots };
  }));
  await check(2, () => h.withPage(async p => {
    const blocks = P.blocks.filter(b => ['body', 'methods'].includes(b.kind) && b.en.length >= 50 && !P.articleInfo?.fields.some(f => f.blockIds.includes(b.blockId)));
    assert(blocks.length, 'No selectable body text'); const surfaces = [];
    for (let n = 0; n < COLORS.length; n++) {
      await reader(p, 'en'); const block = blocks[n % blocks.length], start = blocks.length >= COLORS.length ? 8 : 2 + n * 6, end = start + 5;
      const quote = await realSelection(p, prose(block), start, end), surface = await toolbarGeometry(p); assertToolbar(surface); surfaces.push(surface);
      if (n === 0) await h.shot(p, 'five-colour-floating-toolbar');
      await p.locator('#selection-tools [data-highlight-color=' + COLORS[n] + ']').click(); assert(!await p.locator('#note-dialog').evaluate(e => e.open), 'Immediate highlight opened note editor');
      const backup = await h.json(p, 'quick-colour-' + COLORS[n] + '.json'); assert(backup.value.annotations.some(a => a.quote === quote && a.color === COLORS[n] && a.start === start && a.end === end), 'Highlight lost selected anchor/color');
    }
    const noteBlock = blocks.at(-1); await addNote(h, p, { block: noteBlock, start: noteBlock.en.length - 24, end: noteBlock.en.length - 8 }); const before = await h.json(p, 'colours-before-refresh.json'); const records = before.value.annotations;
    same([...new Set(records.map(a => a.color))].sort(), [...COLORS].sort(), 'Five colours not retained');
    for (const color of ['pink', 'orange']) { const a = records.find(a => a.color === color); await p.locator('.note-card[data-annotation-id=' + JSON.stringify(a.annotationId) + ']').getByRole('button', { name: '编辑', exact: true }).click(); await p.locator('#note-color').selectOption(color); await p.locator('#note-text').fill('Edited ' + color); await p.locator('#note-form button[type=submit]').click(); }
    const edited = (await h.json(p, 'colours-edited.json')).value.annotations, backgrounds = new Set();
    for (const a of edited) for (const bg of (await assertMarks(p, a)).backgrounds) backgrounds.add(bg);
    assert(backgrounds.size === COLORS.length, 'Five highlight colours visually indistinct');
    await p.reload(); await h.ready(p); same(notesStable((await h.json(p, 'colours-reloaded.json')).value.annotations), notesStable(edited), 'Reload changed notes');
    await h.withPage(async target => { await h.upload(target, h.envelope(edited), 'colours-import.json'); same(notesStable((await h.json(target, 'colours-imported.json')).value.annotations), notesStable(edited), 'Fresh-context JSON lost notes'); });
    const portable = await portableHTML(h, p, 'annotated-portable.html'), snapshot = embedded(portable.bytes.toString('utf8'), 'embedded-notes'); assert(snapshot.snapshotId, 'Portable snapshot identity missing');
    await h.withPage(async target => {
      same(notesStable((await h.json(target, 'portable-initial.json')).value.annotations), notesStable(edited), 'New environment portable snapshot changed');
      for (const a of edited) { await target.locator('.note-card[data-annotation-id=' + JSON.stringify(a.annotationId) + ']').getByRole('button', { name: '编辑', exact: true }).click(); await target.locator('#delete-note').click(); }
      await target.reload(); await h.ready(target); const empty = (await h.json(target, 'portable-deleted-reloaded.json')).value;
      assert(empty.annotations.length === 0 && empty.embeddedSnapshots?.includes(snapshot.snapshotId), 'Embedded snapshot resurrected deleted notes');
    }, { file: portable.file });
    return { surfaces, colours: COLORS, nativeSelection: true, refresh: true, jsonFreshContext: true, portableFreshContext: true, deletionNotRevived: true };
  }));
  await check(3, async () => {
    const maps = (P.idMap || []).filter(m => m.oldBlockId !== m.newBlockId && m.oldText === m.newText && m.oldEnd - m.oldStart === m.newEnd - m.newStart);
    if (!maps.some(m => m.language === 'en') || !maps.some(m => m.language === 'zh')) return supplemental(h, GATES[3]);
    return h.withPage(async p => {
      const records = ['en', 'zh'].map((lang, n) => { const m = maps.find(x => x.language === lang), end = Math.min(m.oldText.length, lang === 'en' ? 20 : 10), a = h.annotation({ blockId: m.oldBlockId, [lang]: m.oldText }, lang, 0, end, COLORS[n], 'legacy-' + lang); a.start += m.oldStart; a.end += m.oldStart; return a; });
      await h.upload(p, h.envelope(records), 'synthetic-legacy-v1.json'); const actual = (await h.json(p, 'synthetic-legacy-mapped.json')).value.annotations;
      for (const old of records) { const m = maps.find(x => x.language === old.language && x.oldBlockId === old.blockId), a = actual.find(x => x.annotationId === old.annotationId); assert(a?.status === 'located' && a.blockId === m.newBlockId && a.start === m.newStart + old.start - m.oldStart && a.quote === old.quote && a.color === old.color, 'Legacy idMap failed'); await assertMarks(p, a); }
      return { explicitlySyntheticNotes: true, idMapExercised: true, annotations: actual };
    });
  });
  await check(4, () => h.withPage(async p => {
    const links = await p.locator('#toc a[href]').evaluateAll(es => es.map(e => ({ href: e.getAttribute('href'), en: e.querySelector('.toc-en')?.textContent, zh: e.querySelector('.toc-zh')?.textContent })));
    assert(links.length > 0 && links.every(x => x.en && x.zh), 'Bilingual TOC empty/incomplete');
    for (const link of links) assert(await p.locator(id(link.href.slice(1))).count() === 1, 'TOC target missing/duplicate');
    const groups = p.locator('#toc details'); for (let n = 0; n < await groups.count(); n++) { const group = groups.nth(n), before = await group.evaluate(e => e.open), summary = group.locator(':scope > summary'); await summary.focus(); await summary.press('Space'); assert(await group.evaluate(e => e.open) !== before, 'TOC native disclosure failed'); await summary.press('Space'); }
    for (const lang of ['en', 'zh']) { await reader(p, lang); assert(await p.locator('#toc a:visible').evaluateAll(es => es.every(e => e.querySelector('.toc-en').getClientRects().length && e.querySelector('.toc-zh').getClientRects().length)), 'Body language hid a TOC language'); }
    return { links, collapsibleGroups: await groups.count(), hierarchyExpected: Boolean(P.toc?.items.some(x => x.children?.length)), screenshot: await h.shot(p, 'bilingual-toc') };
  }));
  await check(5, () => h.withPage(async p => {
    if (!P.articleInfo?.fields?.length) throw new Blocked('Independent source metadata has no configured fields; use explicit metadata regression fixture');
    const observations = [];
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await p.setViewportSize(size); await settle(p);
      const fields = await p.locator('.article-info-fields > .info-field').evaluateAll(es => es.map(e => ({ label: e.querySelector('.info-label')?.textContent, value: e.querySelector('.info-value')?.textContent, layout: e.dataset.infoLayout, hasTable: !!e.closest('.article-info-table') })));
      assert(fields.length === P.articleInfo.fields.length && fields.every(f => f.label && f.value && f.layout === 'table-row' && f.hasTable), 'Compact two-column metadata fields missing');
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Metadata causes horizontal overflow'); observations.push({ size, fields });
    }
    return { observations, canonicalMetadataComparedInSourceGate: true };
  }));
  await check(6, () => h.withPage(async p => {
    const samples = []; for (const size of [{ width: 1440, height: 1000 }, { width: 1024, height: 600 }, { width: 390, height: 844 }]) {
      await p.setViewportSize(size); for (const f of h.figureLedger.figures) { await selectFigure(p, f.figureId); const g = await figureGeometry(p); assertContain(g); samples.push({ size, figureId: f.figureId, geometry: g }); }
    }
    return { independentExpectedFigures: h.figureLedger.figures.length, samples, screenshot: await h.shot(p, 'mobile-full-figure') };
  }));
  await check(7, () => h.withPage(async p => {
    assert(P.figures.length > 0, 'Figure interaction requires independent figure ledger'); await selectFigure(p, P.figures[0].figureId); assertContain(await figureGeometry(p));
    await p.locator('#figure-zoom-in').click(); const zoomed = await figureGeometry(p); assert(zoomed.relative > 1, 'Figure zoom failed');
    const box = await rect(p.locator('.figure-viewport')), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 35, y + 25, { steps: 12 }); await p.mouse.up(); const panned = await figureGeometry(p); assert(Math.abs(panned.panX) + Math.abs(panned.panY) > 1, 'Real drag did not pan zoomed image');
    await p.locator('#figure-fit').click(); const reset = await figureGeometry(p); assertContain(reset); assert(Math.abs(reset.panX) < 1 && Math.abs(reset.panY) < 1, 'Fit did not reset pan');
    return { zoomed, panned, reset };
  }));
  await check(8, () => h.withPage(async p => {
    const rows = await canonicalDOM(p), byKey = new Map(rows.map(r => [r.blockId + ':' + r.language, r]));
    const expected = P.blocks.filter(b => !['header-footer', 'figure-label'].includes(b.kind));
    for (const b of expected) for (const lang of ['en', 'zh']) assert(byKey.get(b.blockId + ':' + lang)?.text === b[lang], 'Rendered canonical text differs ' + b.blockId + '/' + lang);
    assert(rows.length === expected.length * 2, 'Duplicate/missing canonical DOM prose');
    for (const b of P.blocks.filter(b => ['header-footer', 'figure-label'].includes(b.kind))) assert(b.exclusionReason, 'Original-only source glyphs lack exclusion reason');
    return { independentSource: h.report.sourceAudit, displayedBlocks: expected.length, exactBilingualStrings: rows.length, sourceBlocks: P.blocks.length, sourceEdits: P.sourceEdits || [], note: 'Text identity against audited canonical data; scientific/translation quality remains separately evidenced' };
  }));
  await check(9, () => h.withPage(async p => {
    assert(await p.locator('#article .block.caption').count() === 0, 'Legend duplicated in article');
    assert(await p.locator('#figure-caption-content .block.caption').count() === P.blocks.filter(b => b.kind === 'caption').length, 'Canonical caption pool incomplete');
    const selected = []; for (const f of P.figures) { await selectFigure(p, f.figureId); const visible = await p.locator('#figure-caption-content .block.caption:visible').evaluateAll(es => es.map(e => e.dataset.blockId)); assert(f.captionBlockIds.every(x => visible.includes(x)), 'Figure caption association hidden'); selected.push({ figureId: f.figureId, visible }); }
    await selectFigure(p, P.figures[0].figureId); const metrics = await fontMetrics(p); assert(metrics.values.length === 4 && new Set(metrics.values.map(x => x.px)).size === 1, 'Article/Legend EN/ZH font differs');
    assert(await p.locator('#figure-caption-content').evaluate(e => getComputedStyle(e).backgroundColor) === 'rgb(237, 245, 236)', 'Green Legend background changed');
    return { selected, metrics, screenshot: await h.shot(p, 'green-legend') };
  }));
  await check(10, () => h.withPage(async p => {
    const links = await p.locator('#toc a[href]').evaluateAll(es => es.map(e => e.getAttribute('href'))), samples = [...new Set([links[0], links[Math.floor(links.length / 2)], links.at(-1)])], results = [];
    for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) { await p.setViewportSize(size); for (const href of samples) results.push({ size, ...await clickToc(p, href) }); }
    await p.locator('#figure-toggle').click(); assert(await p.locator('#figure-pane').evaluate(e => e.classList.contains('open')), 'Mobile figure pane did not open');
    const pane = await rect(p.locator('#figure-pane')), toolbar = await rect(p.locator('.toolbar')); assert(pane.y >= toolbar.bottom + 6, 'Mobile figure overlaps toolbar'); await p.locator('#figure-close').click(); assert(!await p.locator('#figure-pane').evaluate(e => e.classList.contains('open')), 'Mobile figure close failed'); return { targets: results, screenshot: await h.shot(p, 'mobile-navigation') };
  }));
  await check(11, () => h.withPage(async p => {
    const results = []; for (const selector of ['#sidebar-splitter', '#figure-splitter']) {
      const split = p.locator(selector), before = Number(await split.getAttribute('aria-valuenow')), box = await rect(split), x = box.x + box.width / 2, y = Math.min(400, box.y + box.height / 2);
      assert(await split.getAttribute('role') === 'separator', 'Splitter semantics missing'); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 65, y, { steps: 12 }); await p.mouse.up();
      const after = Number(await split.getAttribute('aria-valuenow')); assert(Math.abs(after - before) > 20, 'Column drag ineffective'); await split.focus(); await split.press('Home'); assert(Math.abs(Number(await split.getAttribute('aria-valuenow')) - Number(await split.getAttribute('aria-valuemin'))) <= 1, 'Splitter minimum failed'); await split.press('End'); assert(Math.abs(Number(await split.getAttribute('aria-valuenow')) - Number(await split.getAttribute('aria-valuemax'))) <= 1, 'Splitter maximum failed'); await split.dblclick(); results.push({ selector, before, after });
    }
    await p.setViewportSize({ width: 390, height: 844 }); await settle(p); assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile column overflow'); assert(!await p.locator('#sidebar-splitter').isVisible() && !await p.locator('#figure-splitter').isVisible(), 'Mobile splitters not hidden'); return { results };
  }));
  await check(12, () => h.withPage(async p => {
    const target = P.blocks.find(b => ['body', 'methods'].includes(b.kind) && P.inlineReferences.some(r => r.blockId === b.blockId && r.language === 'en'));
    if (!target) throw new Blocked('Follow interaction requires source-evidenced figure reference; use separate fixture');
    await reader(p, 'en'); const linked = [...new Set(P.inlineReferences.filter(r => r.blockId === target.blockId && r.language === 'en').flatMap(r => r.figureIds))];
    await expose(p, prose(target)); const bodyRect = await rect(p.locator(prose(target))), toolbarRect = await rect(p.locator('.toolbar')); await p.mouse.move(bodyRect.x + Math.min(30, bodyRect.width / 2), Math.max(toolbarRect.bottom + 30, Math.min(p.viewportSize().height - 30, bodyRect.y + 20))); await p.mouse.wheel(0, bodyRect.y + bodyRect.height / 2 - (toolbarRect.bottom + p.viewportSize().height) / 2); await p.waitForTimeout(300); assert(linked.includes(await p.locator('#figure-select').inputValue()), 'Figure follow did not select explicit reference');
    const manual = P.figures.find(f => !linked.includes(f.figureId)) || P.figures[0]; await selectFigure(p, manual.figureId); await p.locator('#pin').click(); await p.mouse.wheel(0, 130); await p.waitForTimeout(180); assert(await p.locator('#figure-select').inputValue() === manual.figureId, 'Pin did not hold selected figure'); await p.locator('#pin').click();
    const y = await p.evaluate(() => scrollY); await p.locator('#zoom').click(); await p.locator('#zoom-in').click(); await p.locator('#zoom-image').click(); assert(await p.locator('#image-dialog').evaluate(e => e.open), 'Modal image click unexpectedly closes'); await p.locator('#zoom-fit').click(); const stage = await rect(p.locator('#image-scroll')); await p.mouse.click(stage.x + 2, stage.y + 2); assert(!await p.locator('#image-dialog').evaluate(e => e.open), 'Modal background close failed'); await p.waitForFunction(y => document.body.style.position !== 'fixed' && Math.abs(scrollY - y) < 1, y, { timeout: 2500 }); assert(Math.abs(await p.evaluate(() => scrollY) - y) < 1, 'Modal close moved reading position');
    const download = await portableHTML(h, p, 'automatic-export.html'); await p.locator('#download-html').click(); const second = (await p.locator('#export-preview').textContent()).trim(); assert(second !== download.suggestedFilename, 'Repeated export silently reuses filename'); await p.locator('[data-close=export-dialog]').click(); return { target: target.blockId, figureIds: linked, exportedFilename: download.suggestedFilename, repeatedFilename: second };
  }));
  await check(13, () => h.withPage(async p => {
    const eligible = P.pages.map(pg => ({ page: pg, block: P.blocks.find(b => !['caption', 'figure-label', 'header-footer'].includes(b.kind) && b.sourceSpans[0]?.pageId === pg.pageId && !P.articleInfo?.fields.some(f => f.blockIds.includes(b.blockId))) })).filter(x => x.block);
    assert(eligible.length, 'No source button target'); const first = eligible[0], mid = eligible[Math.floor(eligible.length / 2)], last = eligible.at(-1), other = eligible[Math.floor(eligible.length / 3)];
    const sequence = [other, mid, first, last, other], jumps = [];
    for (const item of sequence) { await reader(p, 'en'); const button = await expose(p, '#article ' + id(item.block.blockId) + ' .source-link'); const start = h.report.inputEvents.length; await button.click(); const native = await nativePDF(p, item.page.number); assert(h.report.inputEvents.slice(start).some(e => e.trusted && e.type === 'pointerdown' && e.targetClass.includes('source-link')), 'Native jump lacks source-button input'); jumps.push({ number: item.page.number, blockId: item.block.blockId, nativeCounter: native.actual }); }
    return { sequenceDerivedFromIndependentPages: true, jumps, counterNeverFilledForJump: true };
  }));
  await check(14, () => h.withPage(async p => {
    await reader(p); await selectFigure(p, P.figures[0].figureId); const observations = [];
    for (const [button, target] of [['#reading-font-increase', 26], ['#reading-font-decrease', 14]]) { for (let n = 0; n < 15; n++) { if (await p.locator(button).isDisabled()) break; await p.locator(button).click(); } const metrics = await fontMetrics(p); assert(metrics.values.length === 4 && metrics.values.every(x => x.px === target), 'Article/Legend EN/ZH font bounds differ'); assert(metrics.scrollWidth <= metrics.width + 1 && metrics.transform === 'none' && ['', 'normal', '1'].includes(metrics.zoom), 'Font implemented as page scale/overflow'); observations.push(metrics); assert(await p.locator(button).isDisabled(), 'Font bound button not disabled'); }
    await p.locator('#reading-font-increase').click(); await p.locator('#reading-font-increase').click(); await p.reload(); await h.ready(p); await selectFigure(p, P.figures[0].figureId); assert((await fontMetrics(p)).values.every(x => x.px === 16), 'Article preference not persisted');
    const href = await p.locator('#toc a[href]').last().getAttribute('href'); const anchor = await clickToc(p, href); const portable = await portableHTML(h, p, 'font-portable.html'); await h.withPage(async target => { await selectFigure(target, P.figures[0].figureId); assert((await fontMetrics(target)).values.every(x => x.px === 16), 'Portable font preference lost'); }, { file: portable.file }); return { observations, reloadSize: 16, anchor, portableSize: 16 };
  }));
  await check(15, () => h.withPage(async p => {
    assert(await p.locator('#search').getAttribute('placeholder') === '搜索中英文全文…', 'Search placeholder changed');
    await addNote(h, p, { note: 'Search anchor preservation', color: 'pink' }); const annotations = (await h.json(p, 'search-before-notes.json')).value.annotations; await reader(p, 'en'); const before = await canonicalDOM(p), observations = [];
    const terms = [h.body.en.match(/[A-Za-z]{4,}/)?.[0] || h.body.en.slice(8, 24).trim(), h.body.zh.slice(2, Math.min(10, h.body.zh.length)).trim()];
    for (const query of terms) { const result = await search(p, query); assert(result.total === expectedMatches(P, query) && result.total > 0, 'Local bilingual search count differs from canonical occurrences'); assert(result.active.every(s => s.toLocaleLowerCase() === query.toLocaleLowerCase()), 'Search range text differs'); await p.locator('#search-next').click(); await settle(p); const next = await searchState(p); assert(next.index === (result.index + 1) % result.total, 'Next match failed'); await p.locator('#search-previous').click(); await settle(p); assert((await searchState(p)).index === result.index, 'Previous match failed'); observations.push({ query, result }); }
    assert(await p.locator(prose(h.body, 'zh')).isVisible(), 'Hidden-language search match remained hidden');
    const caption = P.blocks.find(b => b.kind === 'caption' && b.en.length > 25); if (caption) { const query = caption.en.slice(0, 20).trim(); await search(p, query); assert(await p.locator(prose(caption)).isVisible(), 'Caption search did not reveal Legend'); }
    await p.locator('#search-clear').click(); await settle(p); const empty = await searchState(p); assert(empty.total === 0 && empty.index === -1 && !empty.status && !empty.active.length && !empty.overlayRects, 'Search clear left transient marks');
    same(await canonicalDOM(p), before, 'Search changed canonical DOM text/formatting nodes'); same(notesStable((await h.json(p, 'search-after-notes.json')).value.annotations), notesStable(annotations), 'Search changed permanent note anchors');
    return { observations, notesUnchanged: true, canonicalDOMUnchanged: true, localRequestsOnly: true, screenshot: await h.shot(p, 'search-clear-notes') };
  }));
  await check(16, () => h.withPage(async (p, handle) => {
    await reader(p, 'en'); await expose(p, prose(h.body)); const g = await rangeGeometry(p.locator(prose(h.body)), 8, 12), events = h.report.inputEvents.length;
    const cdp = await handle.context.newCDPSession(p); await cdp.send('Input.synthesizeTapGesture', { x: g.x1, y: g.y1, duration: 1200, tapCount: 1, gestureSourceType: 'touch' });
    await p.locator('#selection-tools').waitFor({ state: 'visible' }); const quote = await p.evaluate(() => String(getSelection())); assert(quote.length > 0, 'Native mobile longpress produced no selection'); const surface = await toolbarGeometry(p); assertToolbar(surface);
    assert(h.report.inputEvents.slice(events).some(e => e.trusted && e.type === 'touchstart'), 'No trusted native touchstart recorded'); await h.shot(p, 'mobile-native-selection'); await p.locator('#selection-tools [data-highlight-color=orange]').tap();
    const result = (await h.json(p, 'mobile-native-note.json')).value.annotations; assert(result.some(a => a.quote === quote && a.color === 'orange'), 'Touch swatch lost native selection'); await p.reload(); await h.ready(p); same(notesStable((await h.json(p, 'mobile-native-reloaded.json')).value.annotations), notesStable(result), 'Touch annotation not persistent');
    await reader(p); const toolbar = await rect(p.locator('.toolbar')); assert(toolbar.right <= 391, 'Mobile search/tool controls overflow'); return { mechanism: 'Chromium native Input.synthesizeTapGesture 1200 ms touch; no Selection injection', quote, surface, screenshot: await h.shot(p, 'mobile-persisted') };
  }, { mobile: true }));
  await check(17, async () => {
    const cases = [{ kind: 'quota' }, { kind: 'read' }, { kind: 'corrupt', raw: '{"syntheticIncomplete":' }], results = [];
    for (const fault of cases) await h.withPage(async p => { await addNote(h, p, { note: 'Storage failure ' + fault.kind }); assert(await p.locator('#storage-warning').isVisible(), 'Storage failure hidden'); const raw = await p.evaluate(() => ({ reads: window.__acceptanceStorage.reads, writes: window.__acceptanceStorage.writes, raw: window.__acceptanceStorage.readRaw() })); if (fault.raw !== undefined) assert(raw.raw === fault.raw && raw.writes === 0, 'Corrupt private storage overwritten'); const note = (await h.json(p, 'storage-' + fault.kind + '.json')).value; assert(note.annotations.some(a => a.note === 'Storage failure ' + fault.kind), 'Storage error discarded memory note'); results.push({ kind: fault.kind, raw, annotations: note.annotations.length }); }, { fault });
    return { isolatedFaultsOnly: true, results };
  });
  await check(18, () => h.withPage(async p => {
    await addNote(h, p, { note: 'JSON Markdown source note', color: 'blue' }); const first = await h.json(p, 'roundtrip-original.json'); const md = await h.download(p, '#export-md', 'roundtrip.md'); const text = md.bytes.toString('utf8'); for (const a of first.value.annotations) assert(text.includes(a.note) && text.includes(a.quote), 'Markdown dropped note/quote');
    await h.withPage(async target => { await h.upload(target, first.value, 'roundtrip-upload.json'); const actual = (await h.json(target, 'roundtrip-restored.json')).value; same(notesStable(actual.annotations), notesStable(first.value.annotations), 'JSON roundtrip changed complete payload'); await h.upload(target, first.value, 'roundtrip-duplicate.json'); assert((await h.json(target, 'roundtrip-deduplicated.json')).value.annotations.length === first.value.annotations.length, 'Repeated JSON import duplicated records'); });
    return { annotations: first.value.annotations.length, markdownFilename: md.suggestedFilename, freshContextRoundtrip: true, deduplicated: true };
  }));
  await check(19, () => h.withPage(async p => {
    const original = h.annotation(), colors = COLORS.slice(0, 3).map((color, n) => h.annotation(h.body, 'en', 8 + n * 16, 20 + n * 16, color, 'legacy-colour-' + color)); await h.upload(p, h.envelope(colors), 'legacy-three-colours.json');
    const backup = (await h.json(p, 'legacy-three-restored.json')).value; same([...new Set(backup.annotations.map(a => a.color))].sort(), ['blue', 'green', 'yellow'], 'Legacy three colours lost');
    await h.upload(p, h.envelope([original]), 'conflict-original.json'); await h.upload(p, h.envelope([{ ...original, color: 'green', note: 'Synthetic conflicting revision' }]), 'conflict-revision.json');
    const foreign = { ...original, annotationId: 'synthetic-foreign', sourceSha256: 'e'.repeat(64), sourceDocumentId: 'synthetic-foreign-document' }; await h.upload(p, h.envelope([foreign], { sourceSha256: 'e'.repeat(64), documentId: 'synthetic-foreign-document' }), 'foreign-provenance.json');
    const final = (await h.json(p, 'conflict-final.json')).value.annotations; assert(final.some(a => a.annotationId === original.annotationId && a.note === original.note), 'Conflict overwrote original'); assert(final.some(a => a.conflictOf === original.annotationId && a.note === 'Synthetic conflicting revision'), 'Conflict copy missing'); assert(final.some(a => a.annotationId === foreign.annotationId && a.status === 'unresolved' && a.sourceSha256 === foreign.sourceSha256), 'Foreign annotation falsely located');
    await p.reload(); await h.ready(p); same(notesStable((await h.json(p, 'conflict-reloaded.json')).value.annotations), notesStable(final), 'Conflict reload changed records'); return { explicitlySynthetic: true, legacyThreeColours: true, conflictPreserved: true, foreignUnresolved: true };
  }));
}

async function main() {
  const o = options(process.argv.slice(2)), h = new Harness(o);
  try {
    if (o.only) for (const name of o.only.split(',')) assert(GATES.includes(name), 'Unknown gate ' + name);
    await h.prepare();
    if (o['preflight-only'] === 'true') { h.report.preflightOnly = true; return; }
    await h.launch(); await runReaderGates(h); assert(h.report.errors.length === 0, 'Unhandled browser errors'); assert(h.report.httpRequests.length === 0, 'Reader attempted external requests');
  } catch (error) { h.report.fatal = error.stack; console.error(error.stack); }
  finally { await h.finish().catch(error => { h.report.cleanupError = error.stack; }); if (h.report.fatal || h.report.cleanupError || h.report.summary?.fail || h.report.summary?.blocked) process.exitCode = 1; }
}
Object.assign(module.exports, { clickToc, canonicalDOM, fontMetrics, searchState, search, expectedMatches, portableHTML, runReaderGates });
if (require.main === module) main();
