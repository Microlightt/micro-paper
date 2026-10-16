const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, writeFile, readFile, readdir, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');
const names = require('../assets/reader/export-name.js');
const paper = {documentId:'paper-test',sourceSha256:'a'.repeat(64),contentFingerprint:'b'.repeat(64),blocks:[{blockId:'body',en:'Canonical source',zh:'规范原文'}],metadata:{year:2026,titleEn:'A: title / research?',titleZh:'研究标题'},readerSettings:{generatedDate:'2026-10-14',figureInitialScale:1.5}};

test('legacy default and metadata template use a stable generation date', () => {
  assert.equal(names.renderFilename(undefined,paper).filename,'reader.html');
  assert.equal(names.renderFilename('{year}_{title}_{date}',paper).filename,'2026_A_ title _ research__2026-10-14.html');
  assert.equal(names.renderFilename('{titleZh}_{documentId}',paper).filename,'研究标题_paper-test.html');
  assert.equal(names.renderFilename('{date}',paper,'2025-01-02').filename,'2025-01-02.html');
  assert.equal(names.renderFilename('{year}',{metadata:{publicationYear:'2025'}}).filename,'2025.html');
});

test('missing fields get explicit fallbacks and unsupported tokens are rejected', () => {
  const result = names.renderFilename('{year}_{title}_{titleEn}_{titleZh}_{documentId}',{},'2026-10-14');
  assert.equal(result.filename,'unknown-year_untitled-paper_untitled-paper_untitled-paper_paper.html');
  assert.deepEqual(result.missing,['year','title','titleEn','titleZh','documentId']);
  assert.throws(()=>names.renderFilename('{author}',paper),/不支持/);
  assert.throws(()=>names.renderFilename('{title',paper),/括号/);
  assert.throws(()=>names.renderFilename('{date}',paper,'2026-02-30'),/有效/);
  assert.throws(()=>names.renderFilename('{date}',paper,'2026-1-2'),/有效/);
});

test('sanitization prevents paths, device names, controls and misleading extensions', () => {
  for (const name of ['../CON','AUX.html','com1','LPT9.foo.html']) {
    const safe = names.sanitizeFilename(name);
    assert(!/[\\/:*?"<>|\x00-\x1f]/.test(safe));
    assert(!/^(?:CON|AUX|COM1|LPT9)(?:\.|$)/i.test(safe));
  }
  assert.equal(names.sanitizeFilename(' \u202eNUL.HTML. '),'_NUL.html');
  assert.equal(names.sanitizeFilename('a/b\\c:*?"<>|\u0000\n.html'),'a_b_c_.html');
  assert.equal(names.sanitizeFilename(' .. '),'reader.html');
  assert.equal(names.sanitizeFilename('research.HTM'),'research.html');
  assert.equal(names.sanitizeFilename('COM¹.html'),'_COM¹.html');
  const long = names.sanitizeFilename('研究'.repeat(200));
  assert(Buffer.byteLength(long)<=240);
  assert(!long.includes('\ufffd'));
  assert(Buffer.byteLength(names.collisionFilename(long,123))<=240);
});

test('case-insensitive collision keys preserve existing names', () => {
  const used = new Set(['READER.HTML','reader (2).html'].map(names.filenameKey));
  assert.equal(names.unusedFilename('reader.html',used),'reader (3).html');
});

test('export preserves pristine document while settings and authorized notes use separate JSON slots', () => {
  const source = '<!doctype html><html><script type="application/json" id="paper-data">{"old":true}</script><script type="application/json" id="embedded-notes">null</script><article></article><script>start()</script></html>';
  const notes = {format:'micro-paper-notes',schemaVersion:1,documentId:paper.documentId,sourceSha256:paper.sourceSha256,contentFingerprint:paper.contentFingerprint,snapshotId:'snapshot-test',annotations:[{annotationId:'unit-note',color:'green',note:'Authorized note snapshot'}]};
  const updated = names.htmlWithSettings(source,paper,'{year}_{titleZh}.html','2026-10-14',notes);
  const data = JSON.parse(updated.match(/id="paper-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.readerSettings.exportFilenameTemplate,'{year}_{titleZh}.html');
  assert.equal(data.readerSettings.figureInitialScale,1.5);
  assert.equal(data.documentId,paper.documentId);
  assert.deepEqual(data.blocks,paper.blocks);
  assert.equal(data.contentFingerprint,paper.contentFingerprint);
  assert(!Object.hasOwn(data,'annotations'));
  assert.deepEqual(JSON.parse(updated.match(/id="embedded-notes">([\s\S]*?)<\/script>/)[1]),notes);
  assert.equal(paper.readerSettings.exportFilenameTemplate,undefined);
  assert(updated.endsWith('<article></article><script>start()</script></html>'));
  assert.throws(()=>names.htmlWithSettings('<html></html>',paper,'reader.html','2026-10-14'),/停止/);
  assert(!names.htmlWithSettings(source,{...paper,metadata:{titleEn:'</script><img>'}},'reader.html','2026-10-14').includes('</script><img>'));
});

test('named publication is atomic and concurrent writers cannot overwrite', async () => {
  const {writeNamedHtml,previewNamedHtml,parseExportOptions} = await import('../scripts/export-name.mjs');
  const work = await mkdtemp(join(tmpdir(),'micro-paper-name-'));
  try {
    await writeFile(join(work,'READER.HTML'),'keep original');
    assert.equal((await previewNamedHtml(work,'reader.html')).filename,'reader (2).html');
    const outputs = await Promise.all([writeNamedHtml(work,'reader.html','first complete HTML'),writeNamedHtml(work,'reader.html','second complete HTML')]);
    assert.equal(new Set(outputs.map(item=>names.filenameKey(item.filename))).size,2);
    assert(outputs.every(item=>item.renamed));
    assert.equal(await readFile(join(work,'READER.HTML'),'utf8'),'keep original');
    const bodies = await Promise.all(outputs.map(item=>readFile(item.output,'utf8')));
    assert.deepEqual(new Set(bodies),new Set(['first complete HTML','second complete HTML']));
    assert(!(await readdir(work)).some(name=>name.endsWith('.tmp')));
    assert.deepEqual(parseExportOptions(['--filename-template','{year}_{title}','--date','2026-10-14','--preview']),{preview:true,template:'{year}_{title}',date:'2026-10-14'});
    assert.throws(()=>parseExportOptions(['--date','2026-02-30']),/Invalid/);
    assert.throws(()=>parseExportOptions(['--filename-template']),/Missing/);
  } finally {await rm(work,{recursive:true,force:true});}
});

test('packager previews without writes, preserves old HTML, and embeds complete offline resources', async () => {
  const work = await mkdtemp(join(tmpdir(),'micro-paper-package-name-'));
  try {
    const source = {...paper,rendererVersion:'1.0.1',pages:[],figures:[]};
    const original = JSON.stringify(source);
    await writeFile(join(work,'paper.json'),original);
    await writeFile(join(work,'reader.html'),'preserve old reader');
    const run = args => {
      const result = spawnSync(process.execPath,[join(__dirname,'../scripts/package.mjs'),work,...args],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      return JSON.parse(result.stdout);
    };
    const before = await readdir(work);
    const preview = run(['--preview','--date','2026-10-14']);
    assert.equal(preview.status,'preview');
    assert.equal(preview.filename,'reader (2).html');
    assert.equal(preview.writes,false);
    assert.deepEqual(await readdir(work),before);
    await writeFile(join(work,'source-manifest.json'),'{"pageCount":0}');
    await writeFile(join(work,'qa-report.json'),'{"content":{"status":"test-only"},"browser":{"status":"blocked"}}');
    await writeFile(join(work,'source.pdf'),'%PDF-1.0\nfixture used only to exercise resource packaging\n');
    const result = run(['--date','2026-10-14']);
    assert.equal(result.filename,'reader (2).html');
    assert.equal(await readFile(join(work,'reader.html'),'utf8'),'preserve old reader');
    assert.equal(await readFile(join(work,'paper.json'),'utf8'),original);
    const html = await readFile(result.output,'utf8');
    const embedded = JSON.parse(html.match(/id="paper-data">([\s\S]*?)<\/script>/)[1]);
    assert.equal(embedded.rendererVersion,'1.6.0');
    assert.equal(embedded.readerSettings.generatedDate,'2026-10-14');
    assert.equal(embedded.readerSettings.figureInitialScale,1.5);
    assert(!/__STYLE__|__PAPER__|__SCRIPT__|__IMAGE_SCRIPT__|__ARTICLE_INFO_SCRIPT__|__EXPORT_SCRIPT__/.test(html));
    assert(html.includes('MicroPaperExportNames'));
    assert(html.includes('data:application/pdf;base64,'));
    const named = run(['--filename-template','{year}_{titleZh}_{date}','--date','2026-10-14']);
    assert.equal(named.filename,'2026_研究标题_2026-10-14.html');
    const repeat = run(['--filename-template','{year}_{titleZh}_{date}','--date','2026-10-14']);
    assert.equal(repeat.filename,'2026_研究标题_2026-10-14 (2).html');
  } finally {await rm(work,{recursive:true,force:true});}
});
