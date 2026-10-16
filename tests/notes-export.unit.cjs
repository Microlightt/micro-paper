const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const exporter=require('../assets/reader/export-name.js');
const notes=require('../assets/reader/notes-state.js');
const paper=()=>({documentId:'self-authored-export-fixture',sourceSha256:'a'.repeat(64),contentFingerprint:'b'.repeat(64),metadata:{year:2024,titleEn:'Self-authored export fixture'},readerSettings:{generatedDate:'2024-01-01'},blocks:[{blockId:'body',en:'A😀B',zh:'甲😀乙'}],formatting:[],idMap:[]});
const record=(extra={})=>({annotationId:'note-1',blockId:'body',language:'en',start:1,end:3,quote:'😀',prefix:'A',suffix:'B',textHash:'c'.repeat(64),color:'blue',note:'Authorized note </script><img src=x>\u2028\u2029',createdAt:'2024-01-01',updatedAt:'2024-01-01',status:'located',...extra});
const pristine=()=> '<!doctype html><html><body><script type="application/json" id="paper-data">{}</script><script type="application/json" id="embedded-notes">null</script><article id="article"></article><script>start()</script></body></html>';
const slot=(html,id)=>JSON.parse(html.match(new RegExp('<script\\b[^>]*\\sid\\s*=\\s*"'+id+'"[^>]*>([\\s\\S]*?)<\\/script>'))[1]);

test('all colours export in an independent safe JSON slot and reopen with empty local state',async()=>{
  const p=paper(),before=JSON.stringify(p),records=notes.COLORS.map((color,i)=>record({annotationId:'colour-'+i,color}));
  const envelope=notes.createEnvelope({paper:p,annotations:records,exportedAt:'2024-01-01',snapshotId:'five-colour-export'});
  const html=exporter.htmlWithSettings(pristine(),p,'reader.html','2024-01-01',envelope);
  assert(!html.includes('</script><img src=x>'));assert(!html.includes('\u2028'));assert(!html.includes('\u2029'));
  const embedded=slot(html,'embedded-notes');assert.deepEqual(embedded.annotations,records);
  const reopened=await notes.mergeEnvelopes({paper:slot(html,'paper-data'),embedded,local:null,locate:async a=>a});
  assert.deepEqual(reopened.annotations.map(a=>a.color),['yellow','blue','green','pink','orange']);assert.equal(reopened.annotations[1].quote,'😀');
  assert.equal(JSON.stringify(p),before);assert.deepEqual(slot(html,'paper-data').blocks,p.blocks);assert.equal(slot(html,'paper-data').contentFingerprint,p.contentFingerprint);
  assert.equal((html.match(/id="embedded-notes"/g)||[]).length,1);assert(html.includes('<article id="article"></article>'));
});
test('a new export replaces an older embedded snapshot instead of accumulating or baking marks',()=>{
  const p=paper(),old=notes.createEnvelope({paper:p,annotations:[record()],snapshotId:'old'}),newer=notes.createEnvelope({paper:p,annotations:[record({color:'green',note:'Current edit'})],snapshotId:'new'});
  const oldHtml=exporter.htmlWithSettings(pristine(),p,'reader.html','2024-01-01',old);
  const newHtml=exporter.htmlWithSettings(oldHtml,p,'reader.html','2024-01-01',newer);
  assert.equal(slot(newHtml,'embedded-notes').snapshotId,'new');assert.equal(slot(newHtml,'embedded-notes').annotations.length,1);assert.equal(slot(newHtml,'embedded-notes').annotations[0].color,'green');
  assert(!newHtml.includes('<mark'));assert(!newHtml.includes('Current edit</p>'));
});
test('legacy HTML gets one independent slot and duplicate slots fail closed',()=>{
  const p=paper(),envelope=notes.createEnvelope({paper:p,annotations:[record()],snapshotId:'legacy-export'});
  const old=pristine().replace('<script type="application/json" id="embedded-notes">null</script>','');
  const html=exporter.htmlWithSettings(old,p,'reader.html','2024-01-01',envelope);
  assert.deepEqual(slot(html,'embedded-notes'),envelope);assert.equal((html.match(/id="embedded-notes"/g)||[]).length,1);
  const duplicate=pristine().replace('</body>','<script id="embedded-notes">null</script></body>');
  assert.throws(()=>exporter.htmlWithSettings(duplicate,p,'reader.html','2024-01-01',envelope),/重复/);
  assert.throws(()=>exporter.htmlWithSettings(pristine(),p,'reader.html','2024-01-01',{annotations:[]}),/快照/);
});
test('calls without a notes callback preserve already embedded notes for compatibility',()=>{
  const p=paper(),envelope=notes.createEnvelope({paper:p,annotations:[record()],snapshotId:'preserved'});
  const first=exporter.htmlWithSettings(pristine(),p,'reader.html','2024-01-01',envelope);
  assert.deepEqual(slot(exporter.htmlWithSettings(first,p,'renamed.html','2024-01-01'),'embedded-notes'),envelope);
});
test('JSON slot replacement recognizes actual id attributes and leaves data-id decoys untouched',()=>{
  const p=paper(),envelope=notes.createEnvelope({paper:p,annotations:[record()],snapshotId:'exact-id'});
  const source=pristine().replace('<body>','<body><script data-id="paper-data">"paper decoy"</script><script data-id="embedded-notes">"notes decoy"</script>');
  const html=exporter.htmlWithSettings(source,p,'reader.html','2024-01-01',envelope);
  assert(html.includes('<script data-id="paper-data">"paper decoy"</script>'));assert(html.includes('<script data-id="embedded-notes">"notes decoy"</script>'));
  assert.equal(slot(html,'embedded-notes').snapshotId,'exact-id');
});
test('real inline export helper contains no raw closing script and does not resemble a second notes slot',()=>{
  const p=paper(),helper=fs.readFileSync(require.resolve('../assets/reader/export-name.js'),'utf8');
  assert(!/<\/script\b/i.test(helper));
  const source=pristine().replace('<script>start()</script>','<script>'+helper+'</script>');
  const envelope=notes.createEnvelope({paper:p,annotations:[record()],snapshotId:'real-inline-helper'});
  const html=exporter.htmlWithSettings(source,p,'reader.html','2024-01-01',envelope);
  assert.equal(slot(html,'embedded-notes').snapshotId,'real-inline-helper');
  assert.equal((html.match(/<script\b[^>]*\sid="embedded-notes"/g)||[]).length,1);
  assert(html.includes(helper));
});

class Control{
  constructor(){this.handlers={};this.value='';this.textContent='';this.disabled=false;this.open=false;}
  addEventListener(name,fn){this.handlers[name]=fn;}showModal(){this.open=true;}close(){this.open=false;}
  emit(name){return this.handlers[name]?.({preventDefault(){}});}
}
function controls(){const ids=['export-dialog','export-form','export-template','export-name','export-preview','export-warning','export-reset','export-confirm'];const els=Object.fromEntries(ids.map(id=>[id,new Control()]));return{els,document:{getElementById:id=>els[id]}};}
test('confirm snapshots the latest records and metadata without touching runtime DOM or original paper',()=>{
  const originalDocument=global.document,{els,document}=controls();global.document=document;
  try{
    const p=paper(),before=JSON.stringify(p),html=pristine();let records=[record({color:'yellow',note:'At dialog open'})],download;
    const names=exporter.createExportNames({paper:p,originalHtml:html,getEnvelope:()=>notes.createEnvelope({paper:p,annotations:records,embeddedSnapshots:['already-applied'],snapshotId:'confirmed-now'}),download:(name,body,mime)=>download={name,body,mime},toast:()=>{}});
    names.open();records=[record({color:'green',note:'Changed before confirmation'})];els['export-form'].emit('submit');
    assert.equal(download.mime,'text/html');assert.equal(slot(download.body,'embedded-notes').annotations[0].note,'Changed before confirmation');assert.equal(slot(download.body,'embedded-notes').annotations[0].color,'green');
    assert.deepEqual(slot(download.body,'embedded-notes').embeddedSnapshots,['already-applied']);assert.equal(slot(download.body,'embedded-notes').snapshotId,'confirmed-now');
    assert.equal(html,pristine());assert.equal(JSON.stringify(p.blocks),JSON.stringify(JSON.parse(before).blocks));assert.equal(p.contentFingerprint,JSON.parse(before).contentFingerprint);assert(!Object.hasOwn(p,'annotations'));
    assert.equal(els['export-dialog'].open,false);
  }finally{global.document=originalDocument;}
});
test('getAnnotations fallback snapshots at submit and getEnvelope takes priority',()=>{
  const originalDocument=global.document,{els,document}=controls();global.document=document;
  try{
    const p=paper();let records=[record()],download;
    const names=exporter.createExportNames({paper:p,originalHtml:pristine(),getAnnotations:()=>records,download:(name,body)=>download=body,toast:()=>{}});
    names.open();records=[record({color:'green'})];els['export-form'].emit('submit');assert.equal(slot(download,'embedded-notes').annotations[0].color,'green');
    const explicit=notes.createEnvelope({paper:p,annotations:[record({color:'yellow'})],snapshotId:'preferred'});
    const next=exporter.createExportNames({paper:p,originalHtml:pristine(),getEnvelope:()=>explicit,getAnnotations:()=>{throw Error('Lower-priority callback must not run');},download:(name,body)=>download=body,toast:()=>{}});
    next.open();els['export-form'].emit('submit');assert.equal(slot(download,'embedded-notes').snapshotId,'preferred');assert.equal(slot(download,'embedded-notes').annotations[0].color,'yellow');
  }finally{global.document=originalDocument;}
});
test('an invalid configured snapshot callback stops download instead of silently exporting stale notes',()=>{
  const originalDocument=global.document,{els,document}=controls();global.document=document;
  try{
    let downloads=0;const names=exporter.createExportNames({paper:paper(),originalHtml:pristine(),getEnvelope:()=>undefined,download:()=>downloads++,toast:()=>{}});
    names.open();els['export-form'].emit('submit');assert.equal(downloads,0);assert.match(els['export-warning'].textContent,/无法核实笔记快照/);assert.equal(els['export-dialog'].open,true);
  }finally{global.document=originalDocument;}
});
