/* Actual mouse/UI note migration between isolated offline Chrome profiles.
 * Never attach to an existing browser or read user profile/annotation storage.
 * node cross-version.cjs --old OLD.html --new NEW.html --out EVIDENCE_DIR
 *   --chrome CHROME_PATH --playwright MODULE [--body-block ID] [--metadata-block ID]
 */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const crypto = require('node:crypto'), {pathToFileURL} = require('node:url');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!options.old || !options.new || !options.out) {
  console.error('Required: --old OLD.html --new NEW.html --out EVIDENCE_DIR'); process.exit(2);
}
const oldFile = path.resolve(options.old), newFile = path.resolve(options.new), out = path.resolve(options.out);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => {if (!condition) throw Error(message);};
const report = {startedAt: new Date().toISOString(), mode: 'two newly launched isolated headless Chrome profiles; offline file://', oldFile, newFile, checks: [], errors: [], httpRequests: [], screenshots: []};
let browser, page, oldBytes, newBytes;
async function evidence() {
  report.summary = {pass: report.checks.filter(c => c.status === 'pass').length,
    fail: report.checks.filter(c => c.status === 'fail').length,
    blocked: report.checks.filter(c => c.status === 'blocked').length};
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2));
}
async function check(name, callback) {
  try {const detail = await callback(); report.checks.push({name, status: 'pass', evidence: detail}); console.log('PASS ' + name);}
  catch (error) {report.checks.push({name, status: 'fail', evidence: error.stack});
    if (page) await screenshot(name + '-failure').catch(() => {}); throw error;}
  await evidence();
}
function embeddedPaper(bytes) {
  const match = bytes.toString('utf8').match(/<script\b[^>]*\bid=["']paper-data["'][^>]*>([\s\S]*?)<\/script>/i);
  assert(match, 'Embedded paper-data missing'); return JSON.parse(match[1]);
}
async function screenshot(name) {
  const filename = name + '.png'; await page.screenshot({path: path.join(out, filename), fullPage: false});
  report.screenshots.push(filename); return filename;
}
async function launch(file) {
  const pw = require(options.playwright || process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await pw.chromium.launch({headless: true, executablePath: options.chrome || process.env.CHROME_EXECUTABLE});
  report.browserVersion = await browser.version();
  const context = await browser.newContext({offline: true, viewport: {width: 1440, height: 1000}, acceptDownloads: true});
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {if (/^https?:/.test(request.url())) report.httpRequests.push(request.url());});
  await page.goto(pathToFileURL(file).href); await page.waitForFunction(() => window.microPaper?.ready);
  assert(await page.locator('#note-count').textContent() === '0', 'Fresh isolated profile unexpectedly contains notes');
  await page.locator('button[data-view=reader]').click(); await page.locator('button[data-language=en]').click();
}
async function closeProfile() {if (browser) await browser.close(); browser = null; page = null;}
async function mouseSelect(selector, start, end) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const bounds = await page.locator(selector).boundingBox(), toolbar = await page.locator('.toolbar').boundingBox();
  const h = page.viewportSize().height, center = bounds.y + bounds.height / 2;
  if (bounds.y < toolbar.y + toolbar.height + 40 || bounds.y + bounds.height > h - 80) {
    await page.mouse.move(bounds.x + 20, Math.max(toolbar.y + toolbar.height + 50, Math.min(h - 100, center)));
    await page.mouse.wheel(0, center - (Math.max(0, toolbar.y + toolbar.height) + h) / 2);
    await page.waitForTimeout(180);
  }
  // Range objects are used only for read-only character geometry. Selection itself is real mouse input.
  const geometry = await page.locator(selector).evaluate((el, {start, end}) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n, count = 0, first, last;
    while (n = walker.nextNode()) {
      if (!first && start < count + n.length) first = {n, o: start - count};
      if (end <= count + n.length) {last = {n, o: end - count}; break;}
      count += n.length;
    }
    const r1 = document.createRange(), r2 = document.createRange();
    r1.setStart(first.n, first.o); r1.setEnd(first.n, Math.min(first.n.length, first.o + 1));
    r2.setStart(last.n, Math.max(0, last.o - 1)); r2.setEnd(last.n, last.o);
    const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
    return {x1: a.left + .3, y1: a.top + a.height / 2, x2: b.right - .3, y2: b.top + b.height / 2, text: el.textContent.slice(start, end)};
  }, {start, end});
  await page.mouse.move(geometry.x1, geometry.y1); await page.mouse.down();
  await page.mouse.move(geometry.x2, geometry.y2, {steps: 18}); await page.mouse.up();
  await page.waitForTimeout(160);
  const selected = await page.evaluate(() => window.getSelection().toString());
  assert(selected === geometry.text, 'Real mouse selection mismatch: ' + JSON.stringify({selected, expected: geometry.text}));
  await page.locator('#selection-tools').waitFor({state: 'visible'}); return selected;
}
async function createNote(block, end, note, expectedCount) {
  const selector = '#' + block.blockId + ' .prose[data-language=en]';
  const quote = await mouseSelect(selector, 0, Math.min(end, block.en.length));
  await page.locator('#selection-note').click(); await page.locator('#note-dialog').waitFor({state: 'visible'});
  await page.locator('#note-text').fill(note); await page.locator('#note-form button[type=submit]').click();
  await page.waitForFunction(count => document.querySelector('#note-count').textContent === String(count), expectedCount);
  assert(await page.locator('#' + block.blockId + ' mark').count() > 0, 'Created note has no visible source mark');
  return {blockId: block.blockId, language: 'en', start: 0, end: quote.length, quote, note};
}
async function downloadNotes(name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-json').click()]);
  const filename = path.join(out, name); await download.saveAs(filename);
  return {filename, backup: JSON.parse(await fs.readFile(filename, 'utf8'))};
}
function sameLocation(old, migrated) {
  for (const key of ['annotationId', 'blockId', 'language', 'start', 'end', 'quote', 'prefix', 'suffix', 'note']) {
    assert(migrated[key] === old[key], 'Cross-version annotation changed ' + key);
  }
  assert(migrated.status === 'located', 'Imported same-source note is not located');
}
async function jumpFromNotes(annotation, shotName) {
  await page.locator('button[data-view=notes]').click();
  const card = page.locator('.note-card[data-annotation-id="' + annotation.annotationId + '"]');
  await card.getByRole('button', {name: '回到原文', exact: true}).click();
  const selector = '#' + annotation.blockId + ' .prose[data-language=' + annotation.language + ']';
  const mark = page.locator(selector + ' mark[data-annotation-id="' + annotation.annotationId + '"]').first();
  await mark.waitFor({state: 'visible'}); assert((await mark.textContent()).length > 0, 'Located annotation has an empty visible mark');
  const visibleQuote = await page.locator(selector + ' mark[data-annotation-id="' + annotation.annotationId + '"]')
    .evaluateAll(elements => elements.map(el => el.textContent).join(''));
  assert(visibleQuote === annotation.quote, 'Visible rendered highlight differs from imported quote');
  const disclosures = await page.locator('#' + annotation.blockId).evaluate(el => {
    const result = []; for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') result.push(p.open);
    return result;
  });
  assert(disclosures.every(Boolean), 'Note jump leaves ancestor information disclosure closed');
  await screenshot(shotName); return {visibleQuote, ancestorDisclosures: disclosures};
}
(async () => {
  await fs.mkdir(out, {recursive: true});
  oldBytes = await fs.readFile(oldFile); newBytes = await fs.readFile(newFile);
  const oldPaper = embeddedPaper(oldBytes), newPaper = embeddedPaper(newBytes);
  const oldById = new Map(oldPaper.blocks.map(b => [b.blockId, b])), newById = new Map(newPaper.blocks.map(b => [b.blockId, b]));
  const metadataBlock = oldById.get(options['metadata-block']) || oldPaper.blocks.find(b => b.kind === 'authors');
  const bodyBlock = oldById.get(options['body-block']) || oldPaper.blocks.find(b => b.kind === 'body' && b.en.length >= 40);
  await check('source-and-canonical-target-identity', async () => {
    assert(oldPaper.documentId === newPaper.documentId, 'Cross-version document ID differs');
    assert(oldPaper.sourceSha256 === newPaper.sourceSha256, 'Cross-version source PDF differs');
    assert(metadataBlock && bodyBlock, 'Canonical author/body target missing');
    for (const block of [metadataBlock, bodyBlock]) {
      const next = newById.get(block.blockId); assert(next, 'Same-source block ID missing in new reader');
      assert(block.en === next.en && block.zh === next.zh, 'Target canonical text changed across layout versions');
    }
    const changed = oldPaper.blocks.filter(b => !newById.has(b.blockId) || ['en','zh'].some(lang => b[lang] !== newById.get(b.blockId)[lang])).map(b => b.blockId);
    report.identity = {documentId: oldPaper.documentId, sourceSha256: oldPaper.sourceSha256,
      oldContentFingerprint: oldPaper.contentFingerprint, newContentFingerprint: newPaper.contentFingerprint,
      oldHtmlSha256: sha(oldBytes), newHtmlSha256: sha(newBytes), changedCanonicalBlockIds: changed};
    return {...report.identity, targetBlockIds: [metadataBlock.blockId, bodyBlock.blockId]};
  });
  let original, exportedFile;
  await check('old-profile-real-mouse-create-and-json-export', async () => {
    await launch(oldFile);
    const author = await createNote(metadataBlock, 15, 'Isolated QA metadata note created in micro-paper 1.1.0.', 1);
    await screenshot('01-old-author-highlight');
    const body = await createNote(bodyBlock, 24, 'Isolated QA body note created in micro-paper 1.1.0.', 2);
    await screenshot('02-old-body-highlight');
    await page.locator('button[data-view=notes]').click();
    const exported = await downloadNotes('old-created-notes.json'); original = exported.backup; exportedFile = exported.filename;
    assert(original.annotations.length === 2, 'Old UI export does not contain exactly the two QA annotations');
    for (const target of [author, body]) {
      const annotation = original.annotations.find(a => a.blockId === target.blockId);
      for (const key of ['blockId','language','start','end','quote','note']) assert(annotation[key] === target[key], 'Old export mismatch: ' + key);
    }
    await closeProfile(); return {created: [author, body], exportFile: exportedFile, freshProfile: true};
  });
  let imported;
  await check('new-independent-profile-ui-import-and-location', async () => {
    await launch(newFile); await page.locator('button[data-view=notes]').click();
    await page.locator('#import-file').setInputFiles(exportedFile);
    await page.locator('#import-dialog').waitFor({state: 'visible'});
    const preview = await page.locator('#import-preview').textContent();
    assert(preview.includes('新增 2') && preview.includes('待定位 0') && preview.includes('冲突 0'), 'Unexpected import preview: ' + preview);
    await page.locator('#confirm-import').click();
    await page.waitForFunction(() => document.querySelector('#note-count').textContent === '2');
    imported = (await downloadNotes('new-imported-notes.json')).backup;
    for (const old of original.annotations) sameLocation(old, imported.annotations.find(a => a.annotationId === old.annotationId));
    return {preview, annotations: imported.annotations.map(a => ({annotationId: a.annotationId, blockId: a.blockId, start: a.start, end: a.end, quote: a.quote, status: a.status}))};
  });
  await check('imported-metadata-fold-reveal-and-body-highlight-visible', async () => {
    const author = imported.annotations.find(a => a.blockId === metadataBlock.blockId), body = imported.annotations.find(a => a.blockId === bodyBlock.blockId);
    const authorEvidence = await jumpFromNotes(author, '03-new-author-fold-open-highlight');
    assert(authorEvidence.ancestorDisclosures.length > 0, 'New author information did not use a disclosure fixture');
    const bodyEvidence = await jumpFromNotes(body, '04-new-body-highlight');
    return {author: authorEvidence, body: bodyEvidence, operatedButton: '回到原文'};
  });
  const editedText = 'Edited isolated QA metadata note after import into micro-paper 1.1.1.';
  await check('actual-highlight-click-edit-and-reexport', async () => {
    const author = imported.annotations.find(a => a.blockId === metadataBlock.blockId);
    await jumpFromNotes(author, '05-new-author-before-edit');
    await page.locator('#' + author.blockId + ' .prose[data-language=en] mark[data-annotation-id="' + author.annotationId + '"]').first().click();
    await page.locator('#note-dialog').waitFor({state: 'visible'}); await page.locator('#note-text').fill(editedText);
    await page.locator('#note-form button[type=submit]').click(); await page.locator('button[data-view=notes]').click();
    assert((await page.locator('#notes-list').textContent()).includes(editedText), 'Edited note is not visible in Notes UI');
    const final = (await downloadNotes('new-edited-reexport-notes.json')).backup;
    assert(final.annotations.length === 2, 'Re-export lost a QA annotation');
    for (const old of original.annotations) {
      const migrated = final.annotations.find(a => a.annotationId === old.annotationId);
      sameLocation({...old, note: old.blockId === metadataBlock.blockId ? editedText : old.note}, migrated);
    }
    await screenshot('06-new-edited-notes'); return {editedText, exportFile: 'new-edited-reexport-notes.json', sameSourceQuoteIdAndRange: true};
  });
  await check('new-note-reload-and-input-files-unchanged', async () => {
    await page.reload(); await page.waitForFunction(() => window.microPaper?.ready);
    assert(await page.locator('#note-count').textContent() === '2', 'Imported annotations did not persist in their isolated new profile');
    await page.locator('button[data-view=notes]').click(); assert((await page.locator('#notes-list').textContent()).includes(editedText), 'Edited annotation missing after reload');
    assert(sha(await fs.readFile(oldFile)) === sha(oldBytes), 'Read-only old HTML was changed');
    assert(sha(await fs.readFile(newFile)) === sha(newBytes), 'Read-only new HTML was changed');
    assert(report.errors.length === 0, 'Unhandled page errors: ' + report.errors.join(';'));
    assert(report.httpRequests.length === 0, 'Offline cross-version test made HTTP requests');
    return {noteCountAfterReload: 2, inputHashesUnchanged: true, httpRequests: 0, pageErrors: 0};
  });
})().catch(async error => {
  report.fatal = error.stack;
  if (!report.checks.some(c => c.status === 'fail')) report.checks.push({name: 'isolated-chrome-execution', status: 'blocked', evidence: error.stack});
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => {
  await closeProfile().catch(() => {}); report.finishedAt = new Date().toISOString();
  await fs.mkdir(out, {recursive: true}); await evidence(); console.log(JSON.stringify(report.summary));
  if (report.summary.fail || report.summary.blocked) process.exitCode = 1;
});
