/* v1.2.0 legacy regression adaptation. Fresh isolated Chrome; all UI changes use real inputs.
 * Checkbox removal is tested as direct image-only wheel/pan; captions remain canonical in the right pane. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

function args(argv) {
  const result = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) result[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  result.fixture ||= positional[0];
  result.out ||= positional[1];
  return result;
}
const options = args(process.argv.slice(2));
if (!options.fixture) { console.error('Usage: node interactions.cjs --fixture WORK_OR_READER.html --out EVIDENCE_DIR [--chrome PATH] [--playwright MODULE]'); process.exit(2); }
const input = path.resolve(options.fixture);
const work = path.extname(input) === '.html' ? path.dirname(input) : input;
const readerFile = path.extname(input) === '.html' ? input : path.join(input, 'reader.html');
const out = path.resolve(options.out || path.join(work, 'interaction-evidence'));
const assert = (condition, message) => { if (!condition) throw Error(message); };
const report = { fixture: readerFile, mode: 'isolated headless real Google Chrome', startedAt: new Date().toISOString(), checks: [], consoleErrors: [], httpRequests: [], visualInspection: 'pending', screenshots: [] };
let browser, context, page, paper;
const sleep = ms => page.waitForTimeout(ms);
const safe = name => name.replace(/[^a-zA-Z0-9_-]/g, '-');
const rect = locator => locator.boundingBox();
async function ready(p = page) { await p.waitForFunction(() => window.microPaper?.ready); }
async function shot(name, p = page) {
  const filename = safe(name) + '.png';
  await p.screenshot({ path: path.join(out, filename), fullPage: false });
  report.screenshots.push(filename);
  return filename;
}
async function readState(p = page) {
  return p.evaluate(() => {
    const getRect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const img = document.querySelector('#figure-content img'), viewport = document.querySelector('.figure-viewport'), pane = document.querySelector('#figure-pane');
    return { x: scrollX, y: scrollY, paneScroll: pane?.scrollTop, scale: Number(img?.dataset.imageScale), image: img && getRect(img), viewport: viewport && getRect(viewport), bodyTop: document.body.style.top, modalOpen: document.querySelector('#image-dialog').open };
  });
}
async function modalGeometry() {
  return page.evaluate(() => {
    const img = document.querySelector('#zoom-image'), viewport = document.querySelector('#image-scroll');
    const r = e => { const a = e.getBoundingClientRect(); return { x: a.x, y: a.y, width: a.width, height: a.height, right: a.right, bottom: a.bottom }; };
    return { image: r(img), viewport: r(viewport), scale: Number(img.dataset.imageScale), windowY: scrollY, bodyTop: document.body.style.top, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  });
}
function imagePoint(g) { const left = Math.max(g.image.x, g.viewport.x), right = Math.min(g.image.right, g.viewport.right), top = Math.max(g.image.y, g.viewport.y), bottom = Math.min(g.image.bottom, g.viewport.bottom); assert(right > left && bottom > top, 'Actual image has no visible hit area'); return { x: (left + right) / 2, y: (top + bottom) / 2 }; }
async function fresh(viewport = { width: 1440, height: 900 }, file = readerFile) {
  await page.setViewportSize(viewport);
  await page.goto(pathToFileURL(file).href);
  await ready();
  await page.locator('button[data-view=reader]').click();
  await page.locator('button[data-language=both]').click();
  await sleep(100);
}
async function wheelAt(x, y, delta, delay = 170) {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, delta);
  await sleep(delay);
}
async function articleWheel(delta, delay = 210) {
  const box = await rect(page.locator('#article')), toolbar = await rect(page.locator('.toolbar'));
  await wheelAt(box.x + box.width / 2, Math.max(toolbar.y + toolbar.height + 35, 250), delta, delay);
}
async function midpoint() {
  return page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    const article = document.querySelector('#article').getBoundingClientRect();
    const top = Math.max(toolbar.bottom, article.top), bottom = Math.min(innerHeight, article.bottom), anchor = top + Math.max(0, bottom - top) / 2;
    const blocks = [...document.querySelectorAll('#article .block')].map(el => { const r = el.getBoundingClientRect(); return { id: el.dataset.blockId, top: r.top, bottom: r.bottom, center: (r.top + r.bottom) / 2, distance: anchor < r.top ? r.top - anchor : anchor > r.bottom ? anchor - r.bottom : 0 }; });
    const closest = blocks.reduce((a, b) => b.distance < a.distance ? b : a);
    return { anchor, closest, blocks };
  });
}
async function centerBlock(id) {
  for (let i = 0; i < 3; i++) {
    const current = await midpoint(), target = current.blocks.find(b => b.id === id);
    assert(target, 'Block missing: ' + id);
    const delta = target.center - current.anchor;
    if (Math.abs(delta) < 2) break;
    await articleWheel(delta);
  }
  await sleep(210);
  return midpoint();
}
async function group(requirement, name, fn) {
  if (options.only && !options.only.split(',').includes(String(requirement))) return;
  const entry = { requirement, name, status: 'pending' };
  report.checks.push(entry);
  try { entry.evidence = await fn(); entry.status = 'pass'; console.log('PASS ' + requirement + ' ' + name); }
  catch (error) { entry.status = 'fail'; entry.error = error.stack; console.log('FAIL ' + requirement + ' ' + name + ': ' + error.message); entry.screenshot = await shot(name + '-failure').catch(() => null); }
}
async function actualDownload(p = page) {
  const [download] = await Promise.all([p.waitForEvent('download'), p.locator('#export-confirm').click()]);
  const filename = download.suggestedFilename(), target = path.join(out, 'downloads', filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await download.saveAs(target);
  return { filename, target };
}
async function openExport(p = page) { await p.locator('#download-html').click(); await p.locator('#export-dialog').waitFor({ state: 'visible' }); }
async function simpleDownload(selector, filename, p = page) {
  const [download] = await Promise.all([p.waitForEvent('download'), p.locator(selector).click()]);
  const target = path.join(out, filename); await download.saveAs(target); return target;
}
function paperInHtml(html) {
  const match = html.match(/(<script\b[^>]*\bid=["']paper-data["'][^>]*>)([\s\S]*?)(<\/script>)/i);
  assert(match, 'Embedded paper-data missing');
  return { match, data: JSON.parse(match[2]) };
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const rawHtml = await fs.readFile(readerFile, 'utf8');
  report.fixtureSha256 = crypto.createHash('sha256').update(rawHtml).digest('hex');
  report.readerScriptSha256 = crypto.createHash('sha256').update(rawHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '').digest('hex');
  report.readerStyleSha256 = crypto.createHash('sha256').update(rawHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '').digest('hex');
  paper = paperInHtml(rawHtml).data;
  const playwright = require(options.playwright || process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await playwright.chromium.launch({ headless: true, executablePath: options.chrome || process.env.CHROME_EXECUTABLE });
  report.browserVersion = await browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.consoleErrors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) report.httpRequests.push(r.url()); });

  await group(1, 'modal-dismiss-and-resume', async () => {
    await fresh(); await articleWheel(550);
    const before = await readState(); assert(before.y > 100, 'Scrollable body position fixture required');
    await page.locator('#zoom').click();
    await page.waitForFunction(() => document.querySelector('#zoom-image').naturalWidth > 0);
    await page.locator('#zoom-in').click();
    const g = await modalGeometry();
    const x = g.viewport.x + g.viewport.width / 2, y = g.viewport.y + g.viewport.height / 2;
    await page.mouse.click(x, y); await sleep(60);
    assert(await page.locator('#image-dialog').evaluate(e => e.open), 'Image nondrag click closed modal');
    await page.locator('#zoom-out').click();
    assert(await page.locator('#image-dialog').evaluate(e => e.open), 'Tool click closed modal');
    const insideShot = await shot('01-modal-image-and-tools-stay-open');
    await page.mouse.click(2, 2); await sleep(80);
    assert(!(await page.locator('#image-dialog').evaluate(e => e.open)), 'Outside backdrop did not close modal');
    let after = await readState(); assert(Math.abs(after.y - before.y) <= 1, 'Outside close changed body reading position');
    await page.locator('#zoom').click(); await page.locator('#zoom-fit').click();
    const fitted = await modalGeometry();
    const blank = { x: fitted.viewport.x + 2, y: fitted.viewport.y + 2 };
    assert(blank.x < fitted.image.x || blank.y < fitted.image.y, 'Fit padding did not leave a testable blank area');
    await page.mouse.click(blank.x, blank.y); await sleep(80);
    assert(!(await page.locator('#image-dialog').evaluate(e => e.open)), 'Stage blank did not close modal');
    after = await readState(); assert(Math.abs(after.y - before.y) <= 1, 'Stage close changed body reading position');
    await page.locator('#zoom').click(); await page.keyboard.press('Escape'); await sleep(80);
    assert(!(await page.locator('#image-dialog').evaluate(e => e.open)), 'Escape did not close modal');
    const resumed = await readState(); assert(Math.abs(resumed.y - before.y) <= 1, 'Escape changed body position');
    return { before, after, resumed, imageClick: 'stayed open after pointer capture', toolbarClick: 'stayed open', backdropClick: 'closed', stageBlankClick: 'closed', escape: 'closed', screenshots: [insideShot, await shot('01-reading-position-restored')] };
  });

  await group(2, 'pointer-wheel-clamp-and-modal-drag', async () => {
    await fresh(); await articleWheel(500); const beforeBody = await readState();
    await page.locator('#zoom').click();
    for (let i = 0; i < 4; i++) await page.locator('#zoom-in').click();
    const before = await modalGeometry();
    const pointer = { x: before.viewport.x + before.viewport.width * .58, y: before.viewport.y + before.viewport.height * .56 };
    const naturalPoint = { x: (pointer.x - before.image.x) / before.image.width, y: (pointer.y - before.image.y) / before.image.height };
    await wheelAt(pointer.x, pointer.y, -130);
    const after = await modalGeometry();
    const naturalAfter = { x: (pointer.x - after.image.x) / after.image.width, y: (pointer.y - after.image.y) / after.image.height };
    const drift = { x: Math.abs(naturalPoint.x - naturalAfter.x), y: Math.abs(naturalPoint.y - naturalAfter.y) };
    assert(after.scale > before.scale, 'Wheel did not zoom');
    assert(drift.x < .008 && drift.y < .008, 'Pointer image-coordinate anchor drift: ' + JSON.stringify(drift));
    assert(after.windowY === before.windowY && after.bodyTop === before.bodyTop, 'Modal wheel also scrolled body');
    await page.mouse.move(pointer.x, pointer.y); await page.mouse.down(); await page.mouse.move(pointer.x + 60, pointer.y + 45, { steps: 10 }); await page.mouse.up();
    const dragged = await modalGeometry();
    assert(Math.abs(dragged.image.x - after.image.x) > 20 || Math.abs(dragged.image.y - after.image.y) > 20, 'Modal drag did not pan image');
    assert(await page.locator('#image-dialog').evaluate(e => e.open), 'Drag-end click accidentally closed modal');
    const screenshot = await shot('02-pointer-zoom-and-drag');
    for (let i = 0; i < 7; i++) { const g = await modalGeometry(), p = imagePoint(g); await wheelAt(p.x, p.y, -1000, 25); }
    const max = await modalGeometry(); assert(max.scale <= 8 && max.scale >= 7.99, 'Upper zoom clamp failed');
    for (let i = 0; i < 10; i++) { const g = await modalGeometry(), p = imagePoint(g); await wheelAt(p.x, p.y, 1000, 25); }
    const min = await modalGeometry(); assert(min.scale >= .5 && min.scale <= .501, 'Lower zoom clamp failed');
    await page.locator('#zoom-fit').click(); const reset = await modalGeometry(); assert(reset.scale === 1, 'Modal fit did not reset to 1');
    await page.mouse.click(2, 2); await sleep(80); const restored = await readState();
    assert(Math.abs(restored.y - beforeBody.y) <= 1, 'Zoom session changed body reading position');
    return { pointer, naturalPoint, naturalAfter, drift, initialScale: before.scale, wheelScale: after.scale, max: max.scale, min: min.scale, reset: reset.scale, dragDelta: { x: dragged.image.x - after.image.x, y: dragged.image.y - after.image.y }, restoredBodyY: restored.y, screenshots: [screenshot] };
  });

  await group(3, 'direct-image-wheel-initial-size-and-reset', async () => {
    await fresh(); await articleWheel(450); await page.locator('#figure-fit').click();
    assert(await page.locator('#figure-interact').count() === 0, 'Obsolete interaction checkbox remains');
    const active = await readState();
    await wheelAt(active.viewport.x + active.viewport.width * .55, active.viewport.y + active.viewport.height * .5, -240);
    const zoomed = await readState();
    assert(zoomed.scale > active.scale, 'Direct image wheel did not zoom without a checkbox');
    assert(zoomed.y === active.y && zoomed.paneScroll === active.paneScroll, 'Direct image wheel also scrolled reading region');
    const start = { x: zoomed.viewport.x + zoomed.viewport.width / 2, y: zoomed.viewport.y + zoomed.viewport.height / 2 };
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 65, start.y + 35, { steps: 10 }); await page.mouse.up();
    const panned = await readState();
    assert(Math.abs(panned.image.x - zoomed.image.x) > 15 || Math.abs(panned.image.y - zoomed.image.y) > 15, 'Inline drag did not pan');
    assert(!panned.modalOpen, 'Direct inline drag opened modal');
    const zoomShot = await shot('03-inline-active-pan');
    await page.locator('#figure-fit').click(); const fit = await readState(); assert(fit.scale === 1, 'Inline reset failed');
    await page.locator('#figure-initial-scale').fill('1.5'); await page.locator('#figure-initial-scale').press('Tab'); await sleep(80);
    const configured = await readState(); assert(configured.scale === 1.5, 'Initial scale setting did not affect current figure');
    const next = paper.figures.find(f => f.figureId !== 'main:1') || paper.figures[0];
    await page.locator('#figure-select').selectOption(next.figureId); await sleep(80);
    const nextState = await readState(); assert(nextState.scale === 1.5, 'Initial scale setting did not affect subsequent figure');
    await page.reload(); await ready(); assert(await page.locator('#figure-initial-scale').inputValue() === '1.5', 'Initial scale preference did not survive reload');
    const restored = await readState(); assert(restored.scale === 1.5, 'Reload did not apply configured initial size');
    await page.locator('#figure-initial-scale').fill('1'); await page.locator('#figure-initial-scale').press('Tab'); await page.locator('#figure-fit').click();
    return { mode: 'direct image interaction; no checkbox', active, zoomed, panDelta: { x: panned.image.x - zoomed.image.x, y: panned.image.y - zoomed.image.y }, fit: fit.scale, configured: configured.scale, next: nextState.scale, restored: restored.scale, screenshots: [zoomShot, await shot('03-inline-reset')] };
  });

  await group(4, 'midpoint-explicit-follow-hysteresis-and-pin', async () => {
    await fresh();
    const targetRef = paper.inlineReferences.filter(r => r.language === 'en' && r.figureIds.length === 1 && r.figureIds[0].startsWith('extended:') && ['body', 'methods'].includes(paper.blocks.find(b => b.blockId === r.blockId)?.kind)).sort((a, b) => paper.blocks.find(x => x.blockId === a.blockId).en.length - paper.blocks.find(x => x.blockId === b.blockId).en.length)[0];
    assert(targetRef, 'Fixture needs a distinct explicit Extended reference in a reading paragraph');
    const targetId = targetRef.figureIds[0], other = paper.figures.find(f => f.figureId !== targetId).figureId;
    await page.locator('#figure-select').selectOption(other);
    let centered = await centerBlock(targetRef.blockId);
    assert(centered.closest.id === targetRef.blockId, 'Target paragraph is not at left viewport midpoint: ' + centered.closest.id);
    assert(await page.locator('#figure-select').inputValue() === targetId, 'Midpoint explicit figure did not follow');
    const candidates = await page.locator('#figure-candidates button').evaluateAll(els => els.map(e => e.dataset.figureId));
    const expectedCandidates = [...new Set(paper.inlineReferences.filter(r => r.blockId === targetRef.blockId && r.language === 'en').flatMap(r => r.figureIds))];
    const expectedOther = expectedCandidates.filter(id => id !== targetId);
    assert(JSON.stringify([...candidates].sort()) === JSON.stringify([...expectedOther].sort()), 'Current figure plus candidate set differs from the exact explicit paragraph references');
    assert(await page.locator('#figure-candidates').evaluate(el => el.hidden) === (expectedOther.length === 0), 'Redundant single-current candidate visibility incorrect');
    const targetIndex = centered.blocks.findIndex(b => b.id === targetRef.blockId), preceding = centered.blocks[targetIndex - 1], target = centered.blocks[targetIndex];
    assert(preceding, 'Previous block fixture required');
    const boundary = (preceding.bottom + target.top) / 2;
    await articleWheel(boundary - centered.anchor - 10, 45);
    const selections = [await page.locator('#figure-select').inputValue()];
    for (const delta of [12, -12, 12, -12, 12, -12]) { await articleWheel(delta, 25); selections.push(await page.locator('#figure-select').inputValue()); }
    await sleep(200); selections.push(await page.locator('#figure-select').inputValue());
    assert(selections.every(s => s === targetId), 'Boundary jitter caused figure jump: ' + selections.join(','));
    await centerBlock(targetRef.blockId);
    await page.locator('#figure-select').selectOption(other); const manuallyHeld = await page.locator('#figure-select').inputValue();
    const pane = await rect(page.locator('#figure-pane')); await wheelAt(pane.x + pane.width / 2, pane.y + pane.height / 2, 100);
    assert(await page.locator('#figure-select').inputValue() === manuallyHeld, 'Figure-region wheel cleared manual choice');
    await page.locator('#pin').click(); assert(await page.locator('#pin').getAttribute('aria-pressed') === 'true', 'Pin state not exposed');
    await articleWheel(-200); await centerBlock(targetRef.blockId);
    assert(await page.locator('#figure-select').inputValue() === other, 'Pinned manual figure was overwritten by body scrolling');
    const pinnedShot = await shot('04-midpoint-pinned-manual-priority');
    await page.locator('#pin').click(); await articleWheel(3); await sleep(230);
    assert(await page.locator('#figure-select').inputValue() === targetId, 'Unpin did not restore explicit midpoint follow');
    const links = page.locator('#' + targetRef.blockId + ' .figure-ref'), linkIndex = await links.evaluateAll((els, target) => els.findIndex(el => JSON.parse(el.dataset.figures).includes(target)), targetId);
    assert(linkIndex >= 0, 'Explicit target figure link missing'); await links.nth(linkIndex).click();
    assert(await page.locator('#figure-select').inputValue() === targetId, 'Direct explicit figure number click failed');
    return { targetRef: { blockId: targetRef.blockId, exactText: targetRef.exactText, figureId: targetId }, centered, expectedCandidates, candidates, jitterSelections: selections, manualChoice: manuallyHeld, pinnedValue: other, followAfterUnpin: targetId, screenshots: [pinnedShot, await shot('04-midpoint-explicit-follow')] };
  });

  await group(5, 'adaptive-width-height-and-small-screens', async () => {
    const dimensions = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 1440, height: 480 }, { width: 1024, height: 400 }, { width: 390, height: 480 }], sizes = [];
    for (const size of dimensions) {
      await fresh(size); await articleWheel(400);
      if (size.width <= 800 && !(await page.locator('#figure-pane').isVisible())) await page.locator('#figure-toggle').click();
      await page.locator('#figure-fit').click(); await sleep(120);
      const m = await page.evaluate(() => {
        const r = el => { const a = el.getBoundingClientRect(); return { x: a.x, y: a.y, width: a.width, height: a.height, right: a.right, bottom: a.bottom }; };
        const img = document.querySelector('#figure-content img'), viewport = document.querySelector('.figure-viewport');
        return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, toolbar: r(document.querySelector('.toolbar')), main: r(document.querySelector('main')), article: r(document.querySelector('#article')), pane: r(document.querySelector('#figure-pane')), image: r(img), viewport: r(viewport), ratio: img.naturalWidth / img.naturalHeight, fullscreen: !!document.fullscreenElement, prose: getComputedStyle(document.querySelector('#article .prose[data-language=en]')).fontSize, scale: Number(img.dataset.imageScale) };
      });
      assert(m.scrollWidth <= m.width, 'Document horizontal overflow at ' + size.width + '×' + size.height);
      assert(!m.fullscreen, 'Reader entered system fullscreen');
      assert(m.main.x >= -1 && m.main.right <= size.width + 1, 'Main escaped available browser width');
      if (size.width === 1920) assert(m.main.width >= size.width * .92, 'Large display still has a fixed narrow container');
      assert(m.article.width >= Math.min(280, size.width - 40) && m.article.width <= 1000, 'Body column is unreadable at ' + JSON.stringify(size));
      assert(m.pane.bottom <= size.height + 2 && m.pane.y >= m.toolbar.bottom - 2, 'Figure pane exceeds available browser height');
      assert(m.image.width <= m.viewport.width + 1 && m.image.height <= m.viewport.height + 1, 'Fit crops full original image');
      assert(Math.abs(m.image.width / m.image.height - m.ratio) < .002, 'Original image aspect ratio changed');
      assert(m.scale === 1, 'Fit scale does not start at 1');
      // A short window may require scrolling the figure pane to expose the complete fit.
      // Use a real wheel input and verify every image edge can be brought into view.
      if (m.image.bottom > Math.min(m.pane.bottom, size.height) - 5) {
        m.paneScrollAttempts = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          // A previous wheel gesture may still be latched to the body after a resize.
          // Begin a distinct gesture, then reread where the current image actually lies.
          await sleep(220);
          const state = await readState(), visibleBottom = Math.min(m.pane.bottom, size.height);
          if (state.image.bottom <= visibleBottom - 3) break;
          await wheelAt(m.pane.x + 3, Math.max(m.toolbar.bottom + 20, Math.min(size.height - 20, m.pane.y + m.pane.height * .7)), state.image.bottom - visibleBottom + 18, 260);
          m.paneScrollAttempts.push(await readState());
        }
        m.afterPaneScroll = await readState();
        assert(m.afterPaneScroll.image.y >= m.toolbar.bottom - 1 && m.afterPaneScroll.image.bottom <= Math.min(m.pane.bottom, size.height) - 3, 'Short-height pane cannot expose the complete original image: ' + JSON.stringify(m));
      }
      if (size.width <= 800) {
        await page.locator('#figure-toggle').click(); await page.locator('#menu').click(); assert(await page.locator('#sidebar').isVisible(), 'Small-screen contents inaccessible'); await page.locator('#menu').click();
        await page.locator('#figure-toggle').click();
      }
      m.screenshot = await shot('05-layout-' + size.width + 'x' + size.height); sizes.push(m);
    }
    return { sizes };
  });

  await group(6, 'filename-preview-fallback-collision-and-notes', async () => {
    await fresh(); await openExport();
    const defaultName = await page.locator('#export-preview').textContent(), names = require('../assets/reader/export-name.js');
    const expectedDefault = names.renderFilename(paper.readerSettings?.exportFilenameTemplate || 'reader.html', paper, paper.readerSettings?.generatedDate).filename;
    assert(defaultName.trim() === expectedDefault, 'Configured export name changed');
    await page.locator('#export-template').fill('{year}_{title}_{date}');
    const metadataName = await page.locator('#export-preview').textContent();
    assert(metadataName.includes(String(paper.metadata.year || paper.metadata.publicationYear || 'unknown-year')) && metadataName.includes(paper.metadata.titleEn), 'Template metadata/fallback preview incorrect');
    assert(/\d{4}-\d{2}-\d{2}/.test(metadataName), 'Generated date missing from template');
    await page.locator('#export-template').fill('{not-a-token}');
    assert(await page.locator('#export-confirm').isDisabled(), 'Unknown template token silently accepted');
    assert((await page.locator('#export-warning').textContent()).trim(), 'Unknown token error missing');
    await page.locator('#export-template').fill('../?:{year}\\{title}<*>|_{date}');
    const sanitizedTemplate = (await page.locator('#export-preview').textContent()).trim();
    assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(sanitizedTemplate) && sanitizedTemplate.endsWith('.html'), 'Template filename illegal characters survived');
    await page.locator('#export-name').fill('../custom: reader?.txt');
    const editedPreview = (await page.locator('#export-preview').textContent()).trim();
    assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(editedPreview) && editedPreview.endsWith('.html'), 'Edited final name was not preview-sanitized');
    const previewShot = await shot('06-export-editable-sanitized-preview');
    const custom = await actualDownload(); assert(custom.filename === editedPreview, 'Confirmed name differed from preview');
    await openExport(); await page.locator('#export-reset').click(); const first = await actualDownload(); assert(first.filename === 'reader.html', 'Reset did not restore compatible reader.html');
    await openExport(); await page.locator('#export-name').fill('reader.html');
    const duplicatePreview = (await page.locator('#export-preview').textContent()).trim(); assert(duplicatePreview === 'reader (2).html', 'Collision was not disclosed in preview');
    assert((await page.locator('#export-warning').textContent()).trim(), 'Existing-disk/session warning missing');
    const duplicate = await actualDownload(); assert(duplicate.filename === duplicatePreview, 'Collision download silently reused filename');

    const parsed = paperInHtml(rawHtml), missing = structuredClone(parsed.data); missing.metadata = { authors: [] };
    const fallbackFile = path.join(out, 'missing-metadata-reader.html');
    await fs.writeFile(fallbackFile, rawHtml.replace(parsed.match[0], parsed.match[1] + JSON.stringify(missing).replace(/</g, '\\u003c') + parsed.match[3]));
    const fallbackContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }), fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(pathToFileURL(fallbackFile).href); await ready(fallbackPage); await openExport(fallbackPage); await fallbackPage.locator('#export-template').fill('{year}_{title}_{date}');
    const fallbackName = (await fallbackPage.locator('#export-preview').textContent()).trim(); assert(fallbackName.includes('unknown-year') && fallbackName.includes('untitled-paper'), 'Missing metadata did not yield safe fallback');
    await shot('06-missing-metadata-fallback', fallbackPage); await fallbackContext.close();

    await page.locator('button[data-view=notes]').click();
    const emptyFile = await simpleDownload('#export-json', 'empty-notes.json'), backup = JSON.parse(await fs.readFile(emptyFile, 'utf8'));
    const block = paper.blocks.find(b => b.kind === 'body'), quote = block.en.slice(0, 12), marker = 'MICRO_PAPER_SYNTHETIC_NOTE_DO_NOT_EMBED_20261014';
    backup.annotations = [{ annotationId: 'interaction-test-note', blockId: block.blockId, language: 'en', start: 0, end: quote.length, quote, prefix: '', suffix: block.en.slice(quote.length, quote.length + 32), note: marker, textHash: crypto.createHash('sha256').update(block.en).digest('hex'), color: 'yellow', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', status: 'located', sourceSha256: paper.sourceSha256 }];
    const noteFixture = path.join(out, 'synthetic-note-import.json'); await fs.writeFile(noteFixture, JSON.stringify(backup));
    await page.locator('#import-file').setInputFiles(noteFixture); await page.locator('#confirm-import').click();
    assert(await page.locator('#note-count').textContent() === '1', 'Synthetic note import failed');
    const notesJson = await simpleDownload('#export-json', 'notes-compatible.json'), notesMd = await simpleDownload('#export-md', 'notes-compatible.md');
    assert(JSON.parse(await fs.readFile(notesJson, 'utf8')).annotations[0].note === marker, 'Notes JSON compatibility lost note');
    assert((await fs.readFile(notesMd, 'utf8')).includes(marker), 'Notes Markdown compatibility lost note');
    await page.locator('button[data-view=reader]').click(); await openExport(); const annotatedDownload = await actualDownload();
    const exportedText = await fs.readFile(annotatedDownload.target, 'utf8'); assert(!exportedText.includes(marker), 'Reader HTML leaked local annotation');
    const exportedPaper = paperInHtml(exportedText).data;
    for (const key of ['blocks', 'figures', 'inlineReferences', 'formatting', 'pages', 'sourceSha256', 'documentId', 'idMap']) assert(JSON.stringify(exportedPaper[key]) === JSON.stringify(paper[key]), 'HTML export changed canonical ' + key);
    const offline = await browser.newContext({ offline: true, viewport: { width: 1440, height: 900 } }), offlinePage = await offline.newPage(), network = [];
    offlinePage.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    await offlinePage.goto(pathToFileURL(annotatedDownload.target).href); await ready(offlinePage);
    assert(await offlinePage.locator('#note-count').textContent() === '0', 'Downloaded reader inherited local note');
    for (const b of paper.blocks.filter(b => !['figure-label', 'header-footer'].includes(b.kind))) for (const language of ['en', 'zh']) assert(await offlinePage.locator('#' + b.blockId + ' .prose[data-language=' + language + ']').textContent() === b[language], 'Roundtrip altered canonical block text');
    for (const figure of paper.figures) { await offlinePage.locator('#figure-select').selectOption(figure.figureId); await offlinePage.waitForFunction(() => document.querySelector('#figure-content img').naturalWidth > 0); }
    assert(network.length === 0, 'Exported HTML depends on network'); await shot('06-exported-offline-roundtrip', offlinePage); await offline.close();
    return { defaultName, metadataName, sanitizedTemplate, editedPreview, customName: custom.filename, firstName: first.filename, duplicatePreview, duplicateName: duplicate.filename, missingMetadata: fallbackName, syntheticNote: 'imported and JSON/Markdown verified; absent from HTML', exportedHtml: annotatedDownload.target, roundtrip: 'all canonical text and paper fields unchanged; all figures load offline; zero notes', screenshots: [previewShot, '06-missing-metadata-fallback.png', '06-exported-offline-roundtrip.png'] };
  });

  await group('integrity', 'canonical-content-and-runtime', async () => {
    await fresh();
    let count = 0;
    for (const block of paper.blocks.filter(b => !['figure-label', 'header-footer'].includes(b.kind))) for (const language of ['en', 'zh']) {
      assert(await page.locator('#' + block.blockId + ' .prose[data-language=' + language + ']').textContent() === block[language], 'Canonical text changed: ' + block.blockId + ' ' + language); count++;
    }
    assert(report.consoleErrors.length === 0, 'Unhandled browser errors: ' + report.consoleErrors.join('; '));
    assert(report.httpRequests.length === 0, 'Reader made HTTP requests');
    return { canonicalLanguageBlocks: count, browserErrors: report.consoleErrors, httpRequests: report.httpRequests };
  });
})().catch(error => {
  report.startupError = error.stack;
  for (let requirement = 1; requirement <= 6; requirement++) if (!report.checks.some(c => c.requirement === requirement)) report.checks.push({ requirement, status: 'blocked', reason: error.message });
  console.error(error.stack);
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.summary = { pass: report.checks.filter(c => c.status === 'pass').length, fail: report.checks.filter(c => c.status === 'fail').length, blocked: report.checks.filter(c => c.status === 'blocked').length };
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'interactions.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  if (report.summary.fail || report.summary.blocked || report.startupError) process.exitCode = 1;
});
