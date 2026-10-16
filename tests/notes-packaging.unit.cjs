// Uses the real staged package.mjs, index.html and every actual inline helper.
// This is a static integration regression; it does not launch a browser.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const names=require('../assets/reader/export-name.js');
const notes=require('../assets/reader/notes-state.js');
const jsonSlot=(html,id)=>{const matches=[...html.matchAll(new RegExp('<script\\b[^>]*\\sid\\s*=\\s*["\']'+id+'["\'][^>]*>([\\s\\S]*?)<\\/script\\s*>','gi'))];assert.equal(matches.length,1,'Expected exactly one actual JSON slot: '+id);return JSON.parse(matches[0][1]);};
function compileInline(html){
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  let count=0;for(const [,attributes,code] of scripts){if(/\btype\s*=\s*["']application\/json["']/i.test(attributes)){JSON.parse(code);continue;}new vm.Script(code,{filename:'actual-packaged-inline-'+(++count)+'.js'});}
  assert(count>=8,'Actual inline reader modules were not included');return count;
}
test('real package and index export an authorized note snapshot without corrupting inline JavaScript',async()=>{
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'micro-paper-notes-package-'));
  try{
    const paper={schemaVersion:1,documentId:'self-authored-package-fixture',sourceSha256:'a'.repeat(64),contentFingerprint:'b'.repeat(64),rendererVersion:'previous',metadata:{year:2024,titleEn:'Self-authored notes packaging fixture',titleZh:'自制笔记打包测试样例',authors:[]},pages:[],figures:[],sections:[],blocks:[{blockId:'body',kind:'body',en:'A😀B',zh:'甲😀乙'}],formatting:[],inlineReferences:[],idMap:[],sourceEdits:[],issues:[]};
    const original=JSON.stringify(paper);
    await fs.writeFile(path.join(work,'paper.json'),original);
    await fs.writeFile(path.join(work,'source-manifest.json'),JSON.stringify({pageCount:0}));
    await fs.writeFile(path.join(work,'qa-report.json'),JSON.stringify({content:{status:'test-only',errors:[],blocked:[]},browser:{status:'blocked',checks:[]}}));
    await fs.writeFile(path.join(work,'source.pdf'),'%PDF-1.0\nSelf-authored packaging fixture; no research data\n');
    const result=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/package.mjs'),work,'--date','2024-01-01'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const packaged=JSON.parse(result.stdout),pristine=await fs.readFile(packaged.output,'utf8');
    assert(!/__\w+(?:_SCRIPT|_STYLE|_PAPER)__/.test(pristine),'An actual template slot remains unresolved');
    const embeddedPaper=jsonSlot(pristine,'paper-data');assert.equal(embeddedPaper.rendererVersion,'1.6.0');
    assert.equal(jsonSlot(pristine,'embedded-notes'),null);assert(pristine.includes('MicroPaperNotesState'));
    const beforeScripts=compileInline(pristine);
    const records=['yellow','blue','green'].map((color,i)=>({annotationId:'unit-note-'+i,blockId:'body',language:'en',start:1,end:3,quote:'😀',prefix:'A',suffix:'B',textHash:'c'.repeat(64),color,note:'Authorized package snapshot '+color+' </script><img>\u2028',createdAt:'2024-01-01',updatedAt:'2024-01-01',status:'located'}));
    const envelope=notes.createEnvelope({paper:embeddedPaper,annotations:records,exportedAt:'2024-01-01',snapshotId:'real-package-export'});
    const exported=names.htmlWithSettings(pristine,embeddedPaper,'reader.html','2024-01-01',envelope);
    assert.equal(compileInline(exported),beforeScripts);assert.deepEqual(jsonSlot(exported,'embedded-notes'),envelope);
    assert(!exported.includes('</script><img>'));assert(!exported.includes('<mark'));
    const afterPaper=jsonSlot(exported,'paper-data');
    for(const key of ['blocks','figures','pages','formatting','inlineReferences','idMap','sourceEdits','sourceSha256','documentId','contentFingerprint','sourcePdf'])assert.deepEqual(afterPaper[key],embeddedPaper[key],'Canonical paper changed: '+key);
    const reopened=await notes.mergeEnvelopes({paper:afterPaper,embedded:jsonSlot(exported,'embedded-notes'),local:null,locate:async a=>a});
    assert.deepEqual(reopened.annotations.map(a=>a.color),['yellow','blue','green']);assert.equal(reopened.annotations[0].quote,'😀');
    const deletedLocal=notes.createEnvelope({paper:afterPaper,annotations:[],embeddedSnapshots:reopened.embeddedSnapshots});
    assert.deepEqual((await notes.mergeEnvelopes({paper:afterPaper,embedded:envelope,local:deletedLocal,locate:async a=>a})).annotations,[]);
    assert.equal(await fs.readFile(path.join(work,'paper.json'),'utf8'),original);
  }finally{await fs.rm(work,{recursive:true,force:true});}
});
