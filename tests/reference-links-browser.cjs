#!/usr/bin/env node
/* Independent source target audit + actual installed-Chrome citation interaction.
 * Same input flags as reader-generic-v160.cjs, plus --reference-candidates FILE
 * --reference-ledger FILE --reference-audit FILE. No Chrome on import/preflight-only.
 * --development-fixture true permits only clearly tagged authored source fixtures;
 * their evidence remains development-only and cannot be a cold real-paper result.
 */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { Harness, Blocked, options, assert, sha, id, same, assertUTF16Range, rect, settle, reader, prose, expose, realSelection, addNote, notesStable, canonicalDOM, search, searchState } = require('./reader-generic-v160.cjs');
const GATES = ['source-bound-bibliography-citation-targets', 'bibliography-citation-keyboard-mobile-search-notes'];
const citationId = c => 'reference:' + JSON.stringify([c.blockId, c.language]) + ':' + c.start + ':' + c.end;
const citationSelector = c => '.reference-link[data-reference-citation-id=' + JSON.stringify(citationId(c)) + ']';
const sourceKey = x => JSON.stringify([x.glyphRanges.map(r => [r.pageId, r.glyphStart, r.glyphEnd]), x.exactText]);

function verifySourceEvidence(P, M, evidence, role, block) {
  assert(evidence?.sourceSha256 === P.sourceSha256 && evidence.role === role, 'Citation source identity/role missing');
  assert(['glyph-map', 'reviewed-source'].includes(evidence.verification), 'Citation source verification missing');
  assert(Array.isArray(evidence.glyphRanges) && evidence.glyphRanges.length, 'Citation glyph evidence missing');
  let text = ''; const used = new Set();
  for (const range of evidence.glyphRanges) {
    const page = M.pages.find(p => p.pageId === range.pageId); assert(page, 'Citation page absent');
    assert(Number.isInteger(range.glyphStart) && Number.isInteger(range.glyphEnd) && range.glyphStart >= 0 && range.glyphEnd > range.glyphStart && range.glyphEnd <= page.glyphs.length, 'Citation glyph interval invalid');
    for (let n = range.glyphStart; n < range.glyphEnd; n++) { const key = range.pageId + ':' + n; assert(!used.has(key), 'Citation repeats source glyph'); if (block) assert(block.sourceSpans?.some(s => s.pageId === range.pageId && s.glyphStart <= n && s.glyphEnd > n), 'Citation source glyph does not belong to its canonical block'); used.add(key); text += page.glyphs[n].text; }
  }
  assert(text === evidence.exactText, 'Citation evidence text differs from actual independent source glyphs');
  if (evidence.verification === 'reviewed-source') assert(evidence.reviewNote?.trim(), 'Reviewed-source citation lacks review reason');
  return sourceKey(evidence);
}
function verifyReferenceLedger({ paper: P, manifest: M, inventory: I, inventorySha256, candidates: C, candidatesSha256, ledger: L, audit: A, development = false }) {
  assert(A?.status === 'pass' && Array.isArray(A.errors) && A.errors.length === 0, 'Source citation validator has not passed');
  assert(C?.schemaVersion === 1 && C.sourceSha256 === P.sourceSha256, 'Independent citation candidate source mismatch');
  assert(L?.schemaVersion === 1 && L.sourceSha256 === P.sourceSha256 && L.inventorySha256 === inventorySha256 && L.referenceCandidatesSha256 === candidatesSha256, 'Reference ledger does not bind independent source evidence');
  assert(L.referenceLedgerComplete === true, 'Reference semantic source review incomplete');
  same([...new Set(L.reviewedPageNumbers)].sort((a, b) => a - b), I.pages.map(p => p.number), 'Reference source review does not cover every PDF page');
  if (development) assert(L.selfAuthored === true && L.realResearch === false, 'Development flag requires explicitly self-authored fixture ledger');
  else assert(L.realResearch !== false && L.selfAuthored !== true, 'Synthetic fixture cannot count as cold real-paper acceptance');
  const decisions = new Map((L.candidateDecisions || []).map(d => [d.sourceCandidateId, d]));
  assert(decisions.size === (L.candidateDecisions || []).length && decisions.size === C.candidates.length, 'Candidate review missing/duplicate/extra decisions');
  for (const c of C.candidates) { const d = decisions.get(c.sourceCandidateId); assert(d && ['approved', 'excluded'].includes(d.status) && d.reason?.trim(), 'Unresolved/unexplained original-PDF citation candidate ' + c.sourceCandidateId); }
  assert(Array.isArray(L.expectedTargets) && Array.isArray(L.expectedCitations), 'Independent expected reference and citation lists absent');
  const targets = P.referenceTargets || [], citations = P.referenceCitations || [], english = citations.filter(c => c.language === 'en'), chinese = citations.filter(c => c.language === 'zh');
  same(targets.map(t => t.number).sort((a, b) => a - b), L.expectedTargets.map(t => t.number).sort((a, b) => a - b), 'Bibliography membership differs from source ledger');
  assert(new Set(targets.map(t => t.number)).size === targets.length && new Set(targets.map(t => t.blockId)).size === targets.length, 'Ambiguous reference target');
  for (const target of targets) {
    const block = P.blocks.find(b => b.blockId === target.blockId); assert(block?.kind === 'reference', 'Reference target is not actual bibliography block');
    const expected = L.expectedTargets.find(e => e.number === target.number), key = verifySourceEvidence(P, M, target.sourceEvidence, 'bibliography-prefix', block); assert(key === sourceKey(expected), 'Reference number target not source-ledger approved');
  }
  assert(english.length === L.expectedCitations.length, 'Missing/extra source-approved English citation spans');
  const seen = new Set();
  for (const citation of citations) {
    const block = P.blocks.find(b => b.blockId === citation.blockId); assert(block && ['body', 'methods', 'caption'].includes(block.kind), 'Citation placed in ineligible source block');
    assertUTF16Range(block[citation.language], citation.start, citation.end, citation.id); assert(block[citation.language].slice(citation.start, citation.end) === citation.exactText, 'Citation canonical UTF-16 identity differs');
    assert(citation.numbers.length && new Set(citation.numbers).size === citation.numbers.length && citation.numbers.every(n => targets.some(t => t.number === n)), 'Citation has missing/ambiguous bibliography number');
    assert(!seen.has(citationId(citation)), 'Duplicated canonical citation span'); seen.add(citationId(citation));
    if (citation.language === 'en') {
      const key = verifySourceEvidence(P, M, citation.sourceEvidence, 'inline-citation', block), expected = L.expectedCitations.filter(e => sourceKey(e) === key); assert(expected.length === 1, 'Citation source glyphs not independently approved'); same(citation.numbers, expected[0].numbers, 'Citation lexical number order/range differs from source ledger');
      assert(citation.sourceEvidence.classification === 'bibliographic-citation', 'Superscript/numeric token lacks bibliography classification');
    } else {
      const source = english.find(c => c.id === citation.sourceEnCitationId); assert(source, 'Translated citation lacks approved English pairing'); same(citation.numbers, source.numbers, 'Translated citation target numbers differ');
      assert(citation.sourceEvidence?.role === 'translation-citation' && citation.sourceEvidence.verification === 'paired-source' && citation.sourceEvidence.sourceSha256 === P.sourceSha256 && citation.sourceEvidence.reviewNote?.trim(), 'Translated citation pairing proof missing');
    }
  }
  for (const expected of L.expectedCitations) assert(english.filter(c => sourceKey(c.sourceEvidence) === sourceKey(expected)).length === 1, 'Independent source citation omitted or duplicated');
  for (const source of english) assert(chinese.filter(c => c.sourceEnCitationId === source.id).length === 1, 'Source citation lacks exactly one corresponding translated citation');
  for (const c of C.candidates) if (decisions.get(c.sourceCandidateId).status === 'approved') assert([...L.expectedTargets, ...L.expectedCitations].some(e => e.sourceCandidateId === c.sourceCandidateId || sourceKey(e) === sourceKey(c)), 'Approved source candidate absent from expected ledger');
  return { targets: targets.length, englishCitations: english.length, translatedCitations: chinese.length, allSourceCandidates: C.candidates.length, reviewedPages: L.reviewedPageNumbers, excludedCandidates: [...decisions.values()].filter(d => d.status === 'excluded').length, developmentOnly: development };
}
async function prepareReference(h) {
  h.report.referenceRunnerSha256 = sha(await fs.readFile(__filename));
  for (const flag of ['reference-candidates', 'reference-ledger', 'reference-audit']) assert(h.o[flag], 'Missing --' + flag);
  for (const [flag, property] of [['reference-candidates', 'referenceCandidates'], ['reference-ledger', 'referenceLedger']]) { const filename = path.resolve(h.o[flag]), bytes = await fs.readFile(filename); h[property] = JSON.parse(bytes.toString('utf8')); h.inputs[flag] = { path: filename, sha256: sha(bytes), size: bytes.length }; }
  h.report.referenceAudit = await h.stage('independent-reference-ledger-audit', async () => verifyReferenceLedger({ paper: h.paper, manifest: h.manifest, inventory: h.inventory, inventorySha256: h.inputs.inventory.sha256, candidates: h.referenceCandidates, candidatesSha256: h.inputs['reference-candidates'].sha256, ledger: h.referenceLedger, audit: h.referenceAudit, development: h.o['development-fixture'] === 'true' }));
}
async function auditRenderedCitations(h, p) {
  await reader(p); const P = h.paper, snapshots = await p.locator('.reference-link').evaluateAll(es => es.map(e => ({ id: e.dataset.referenceCitationId, numbers: e.dataset.referenceNumbers.split(',').map(Number), citationStart: Number(e.dataset.citationStart), citationEnd: Number(e.dataset.citationEnd), fragmentStart: Number(e.dataset.fragmentStart), fragmentEnd: Number(e.dataset.fragmentEnd), text: e.textContent, tag: e.tagName, href: e.getAttribute('href'), role: e.getAttribute('role'), tabIndex: e.tabIndex, proseBlock: e.closest('.prose')?.dataset.blockId, language: e.closest('.prose')?.dataset.language, sup: !!e.querySelector('sup') || !!e.closest('sup') })));
  const ids = [...new Set(snapshots.map(x => x.id))]; same(ids.sort(), P.referenceCitations.map(citationId).sort(), 'DOM citation membership differs from full source-audited list');
  for (const c of P.referenceCitations) {
    const fragments = snapshots.filter(x => x.id === citationId(c)).sort((a, b) => a.fragmentStart - b.fragmentStart), block = P.blocks.find(b => b.blockId === c.blockId); let cursor = c.start;
    assert(fragments.filter(f => f.tabIndex === 0).length === 1, 'Citation does not have exactly one keyboard tab stop');
    for (const f of fragments) { assert(f.fragmentStart === cursor && f.fragmentEnd > cursor && f.fragmentEnd <= c.end, 'Citation DOM fragments have gap/overlap'); assert(f.text === block[c.language].slice(f.fragmentStart, f.fragmentEnd), 'Citation fragment altered canonical text'); same(f.numbers, c.numbers, 'Citation fragment target numbers changed'); assert(f.proseBlock === c.blockId && f.language === c.language && f.citationStart === c.start && f.citationEnd === c.end, 'Citation fragment source identity differs'); cursor = f.fragmentEnd; if (c.numbers.length === 1) { const target = P.referenceTargets.find(t => t.number === c.numbers[0]); assert(f.tag === 'A' && decodeURIComponent(f.href) === '#' + target.blockId, 'Single citation native anchor wrong'); } else assert(f.tag === 'SPAN' && f.role === 'button', 'Multiple citation is not accessible target chooser'); }
    assert(cursor === c.end && fragments.map(f => f.text).join('') === c.exactText, 'Citation text coverage incomplete');
    const formats = P.formatting.filter(f => f.blockId === c.blockId && f.language === c.language && f.kind === 'sup' && f.start < c.end && f.end > c.start); if (formats.length) assert(fragments.some(f => f.sup), 'Citation lost source superscript');
  }
  for (const target of P.referenceTargets) assert(await p.locator(id(target.blockId)).count() === 1, 'Bibliography destination missing/duplicate');
  assert(await p.locator('.prose .reference-popover').count() === 0, 'Citation popup inserted into canonical prose');
  return { citations: ids.length, fragments: snapshots.length, allFragmentsSourceValidated: true };
}
async function revealCitation(h, p, citation) {
  await reader(p, citation.language); const b = h.paper.blocks.find(b => b.blockId === citation.blockId);
  if (b.kind === 'caption') {
    const owner = h.paper.figures.find(f => f.captionBlockIds.includes(b.blockId));
    if (owner) { const { selectFigure } = require('./reader-generic-v160.cjs'); await selectFigure(p, owner.figureId); }
    else { await search(p, b[citation.language].slice(0, Math.min(24, b[citation.language].length))); }
  }
  const trigger = p.locator(citationSelector(citation)).first(); await trigger.scrollIntoViewIfNeeded();
  if (b.kind !== 'caption') await expose(p, citationSelector(citation) + '[tabindex="0"]');
  return trigger;
}
async function assertTarget(h, p, number) {
  const target = h.paper.referenceTargets.find(t => t.number === number); assert(target, 'Target number absent');
  await p.waitForFunction(blockId => document.activeElement?.id === blockId, target.blockId);
  const b = await rect(p.locator(id(target.blockId))), toolbar = await rect(p.locator('.toolbar'));
  assert(b.y >= toolbar.bottom + 6 && b.y < p.viewportSize().height, 'Bibliography target not visibly located');
  assert(!await p.locator('.reference-popover').isVisible(), 'Citation chooser stayed open after navigation');
  if (p.viewportSize().width <= 800) assert(!await p.locator('#figure-pane').evaluate(e => e.classList.contains('open')), 'Caption citation navigation obscured by mobile Figure pane');
  return { number, blockId: target.blockId, top: b.y, toolbarBottom: toolbar.bottom };
}
async function clickCitation(h, p, citation, number = citation.numbers[0], keyboard = false) {
  const trigger = await revealCitation(h, p, citation);
  if (keyboard) { await trigger.focus(); await trigger.press('Enter'); } else await trigger.click();
  if (citation.numbers.length > 1) {
    const popup = p.locator('.reference-popover'); await popup.waitFor({ state: 'visible' });
    const listed = await popup.locator('[data-reference-target-number]').evaluateAll(es => es.map(e => Number(e.dataset.referenceTargetNumber))); same(listed, citation.numbers, 'Chooser omits/reroutes citation target');
    const link = popup.locator('[data-reference-target-number="' + number + '"]'); if (keyboard) { await link.focus(); await link.press('Enter'); } else await link.click();
  }
  return assertTarget(h, p, number);
}
function representatives(P) {
  const all = P.referenceCitations, categories = {
    single: c => c.numbers.length === 1,
    range: c => c.numbers.length > 1 && /[–—−-]/.test(c.exactText),
    multiple: c => c.numbers.length > 1 && /[,，;]/.test(c.exactText),
    superscript: c => P.formatting.some(f => f.blockId === c.blockId && f.language === c.language && f.kind === 'sup' && f.start < c.end && f.end > c.start),
    caption: c => P.blocks.find(b => b.blockId === c.blockId)?.kind === 'caption'
  }, result = [], absent = [];
  for (const language of ['en', 'zh']) for (const [category, predicate] of Object.entries(categories)) { const citation = all.find(c => c.language === language && predicate(c)); if (citation) result.push({ language, category, citation }); else absent.push({ language, category, reason: 'No such source-approved pattern in this article' }); }
  return { result, absent };
}
async function runReferenceGates(h) {
  await h.check(GATES[0], () => h.withPage(async p => {
    const rendered = await auditRenderedCitations(h, p), samples = representatives(h.paper), clicks = [];
    assert(samples.result.some(x => x.language === 'en') && samples.result.some(x => x.language === 'zh'), 'Bilingual citation representatives unavailable');
    for (const sample of samples.result) for (const number of sample.citation.numbers) clicks.push({ language: sample.language, category: sample.category, citationId: citationId(sample.citation), ...await clickCitation(h, p, sample.citation, number) });
    return { independentSourceAudit: h.report.referenceAudit, rendered, realClicks: clicks, absentSourcePatterns: samples.absent, screenshot: await h.shot(p, 'citation-bibliography-target') };
  }));
  await h.check(GATES[1], async () => {
    const P = h.paper, group = P.referenceCitations.find(c => c.numbers.length > 1), single = P.referenceCitations.find(c => c.numbers.length === 1), selected = group || single;
    assert(selected, 'No approved citation interaction fixture'); const desktop = await h.withPage(async p => {
      const before = await canonicalDOM(p), keyboard = [];
      if (single) keyboard.push(await clickCitation(h, p, single, single.numbers[0], true));
      if (group) {
        const trigger = await revealCitation(h, p, group); await trigger.focus(); await trigger.press('Enter'); const popup = p.locator('.reference-popover');
        await popup.waitFor({ state: 'visible' }); const links = popup.locator('[data-reference-target-number]'); assert(await links.first().evaluate(e => e === document.activeElement), 'Chooser initial focus missing'); await links.first().press('End'); assert(await links.last().evaluate(e => e === document.activeElement), 'Chooser End failed'); await links.last().press('Home'); assert(await links.first().evaluate(e => e === document.activeElement), 'Chooser Home failed'); await links.first().press('ArrowDown'); assert(await links.nth(1).evaluate(e => e === document.activeElement), 'Chooser ArrowDown failed'); await links.nth(1).press('Escape'); assert(!await popup.isVisible() && await trigger.evaluate(e => e === document.activeElement), 'Escape did not restore inline keyboard focus'); keyboard.push(await clickCitation(h, p, group, group.numbers.at(-1), true));
      }
      const block = P.blocks.find(b => b.blockId === selected.blockId); await revealCitation(h, p, selected);
      const query = block[selected.language].slice(Math.max(0, selected.start - 4), Math.min(block[selected.language].length, selected.end + 4)).trim(); const state = await search(p, query); assert(state.total > 0, 'Search across reference link missing');
      await p.locator('#search-clear').click(); await settle(p); assert((await searchState(p)).total === 0, 'Search clear failed'); same(await canonicalDOM(p), before, 'Citation/search changed prose or formatting');
      await revealCitation(h, p, selected); const start = Math.max(0, selected.start - 2), end = Math.min(block[selected.language].length, selected.end + 2), quote = await realSelection(p, prose(block, selected.language), start, end);
      await p.locator('#selection-tools [data-highlight-color=pink]').click(); const backup = await h.json(p, 'citation-note-before.json'), annotation = backup.value.annotations.find(a => a.quote === quote && a.blockId === block.blockId);
      assert(annotation && annotation.start === start && annotation.end === end, 'Permanent citation-crossing highlight lost source offsets'); await revealCitation(h, p, selected);
      const mark = p.locator(prose(block, selected.language) + ' mark[data-annotation-id=' + JSON.stringify(annotation.annotationId) + ']').first(); await mark.click(); await p.locator('#note-dialog').waitFor({ state: 'visible' });
      assert(!await p.locator('.reference-popover').isVisible(), 'Clicking permanent note incorrectly activated citation'); await p.locator('#note-text').fill('Citation/search note remains anchored'); await p.locator('#note-form button[type=submit]').click();
      const saved = (await h.json(p, 'citation-note-edited.json')).value.annotations; await reader(p); await search(p, query); await p.locator('#search-clear').click(); await settle(p);
      same(notesStable((await h.json(p, 'citation-note-after-search.json')).value.annotations), notesStable(saved), 'Search altered citation note anchor'); await reader(p); const after = await auditRenderedCitations(h, p);
      await p.reload(); await h.ready(p); same(notesStable((await h.json(p, 'citation-note-reloaded.json')).value.annotations), notesStable(saved), 'Citation note refresh lost anchor');
      return { keyboard, nativeSelectionQuote: quote, annotation, searchCrossesCitation: true, permanentNotePriority: true, renderedAfterNotes: after };
    });
    const mobile = await h.withPage(async p => {
      const samples = [...new Set([single, group, P.referenceCitations.find(c => P.blocks.find(b => b.blockId === c.blockId)?.kind === 'caption')].filter(Boolean))], targets = [];
      for (const c of samples) {
        const trigger = await revealCitation(h, p, c); await trigger.tap();
        if (c.numbers.length > 1) {
          const popup = p.locator('.reference-popover'); await popup.waitFor({ state: 'visible' }); const r = await rect(popup), t = await rect(p.locator('.toolbar')); assert(r.x >= 0 && r.right <= 391 && r.y >= t.bottom + 5 && r.bottom <= 845, 'Mobile citation chooser overlaps header/viewport'); await h.shot(p, 'mobile-citation-chooser'); await popup.locator('[data-reference-target-number="' + c.numbers.at(-1) + '"]').tap();
        }
        targets.push(await assertTarget(h, p, c.numbers.at(-1)));
      }
      return { touchTaps: true, targets, screenshot: await h.shot(p, 'mobile-reference-target') };
    }, { mobile: true });
    return { desktop, mobile };
  });
}
async function main() {
  const o = options(process.argv.slice(2)), h = new Harness(o, 'reference-links-browser');
  try { if (o.only) for (const name of o.only.split(',')) assert(GATES.includes(name), 'Unknown reference gate ' + name); await h.prepare(); await prepareReference(h); if (o['preflight-only'] === 'true') { h.report.preflightOnly = true; return; } await h.launch(); await runReferenceGates(h); assert(!h.report.errors.length && !h.report.httpRequests.length, 'Unexpected browser error/external request'); }
  catch (error) { h.report.fatal = error.stack; console.error(error.stack); }
  finally { await h.finish().catch(error => { h.report.cleanupError = error.stack; }); if (h.report.fatal || h.report.cleanupError || h.report.summary?.fail || h.report.summary?.blocked) process.exitCode = 1; }
}
module.exports = { GATES, citationId, citationSelector, sourceKey, verifySourceEvidence, verifyReferenceLedger, prepareReference, auditRenderedCitations, revealCitation, assertTarget, clickCitation, representatives, runReferenceGates };
if (require.main === module) main();
