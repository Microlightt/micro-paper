// Actual package.mjs + actual index/assets; static integration, not Chrome evidence.
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const stage=path.resolve(__dirname,'..');
const attribute=(attrs,name)=>attrs.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*["\']([^"\']*)["\']','i'))?.[1];

test('v1.6 actual package omits QA chrome, keeps fixed reading controls and complete diagnostics',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'micro-paper-v130-packaging-'));
  try{
    // Only source assets/data are synthetic. The template, packager and every
    // renderer module are read unchanged from this stage; no substitute slots.
    const work=path.join(tmp,'work');fs.mkdirSync(work);
    const issue={type:'acceptance-pending',blockId:'synthetic-block',detail:{unexpected:['</script><img src=x>',{value:1}],line:'separator\u2028paragraph\u2029end',path:'/synthetic/path'}};
    const scopes={paragraphRepair:{status:'pass',evidence:'Self-authored static packaging fixture'},fullScientificReview:{status:'not-performed'}};
    const paper={schemaVersion:1,documentId:'self-authored-status-packaging',contentFingerprint:'b'.repeat(64),rendererVersion:'previous',
      metadata:{titleEn:'Serialization test fixture',titleZh:'序列化测试样例',authors:[]},
      pages:[{pageId:'p1',number:1,width:600,height:800,rotation:0,assetRef:'page.png'}],
      sections:[],blocks:[],figures:[],formatting:[],inlineReferences:[],idMap:[],sourceEdits:[],sourceSha256:'a'.repeat(64),reviewScopes:scopes,issues:[issue]};
    const qa={schemaVersion:1,sourceSha256:paper.sourceSha256,contentFingerprint:paper.contentFingerprint,
      content:{status:'blocked',errors:[],blocked:[issue,'legacy issue']},browser:{status:'blocked',checks:[]},
      overall:{status:'partial'},reviewScopes:scopes,reviewFingerprint:'synthetic-review-fingerprint',rendererFingerprint:'synthetic-renderer-fingerprint'};
    const write=(name,value)=>fs.writeFileSync(path.join(work,name),JSON.stringify(value));
    write('paper.json',paper);write('qa-report.json',qa);write('source-manifest.json',{pageCount:1});
    write('review.json',{components:{body:{state:'absent',evidence:'Synthetic packaging-only fixture'}}});
    fs.writeFileSync(path.join(work,'page.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
    const pdf=Buffer.from('%PDF-1.4\n% Self-authored static packaging bytes; not a scientific document.\n%%EOF\n');
    fs.writeFileSync(path.join(work,'source.pdf'),pdf);
    const beforePaper=fs.readFileSync(path.join(work,'paper.json')),beforeQa=fs.readFileSync(path.join(work,'qa-report.json'));
    const result=spawnSync(process.execPath,[path.join(stage,'scripts/package.mjs'),work,'--date','2024-01-01'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const built=JSON.parse(result.stdout),html=fs.readFileSync(built.output,'utf8');
    const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const paperScripts=scripts.filter(m=>attribute(m[1],'id')==='paper-data');
    assert.equal(paperScripts.length,1,'one actual canonical data slot');
    const data=JSON.parse(paperScripts[0][2]);
    assert.deepEqual(data.qa,qa,'nested diagnostics survive as exact JSON values');
    assert.deepEqual(data.reviewScopes,scopes);assert.deepEqual(data.issues,[issue]);
    assert.equal(data.rendererVersion,'1.6.0');
    assert.equal(data.reviewScopes.fullScientificReview.status,'not-performed');
    assert.equal(data.qa.overall.status,'partial','machine packaging does not promote scientific scope');
    assert.equal(data.sourcePdf,'data:application/pdf;base64,'+pdf.toString('base64'));
    assert.deepEqual(fs.readFileSync(path.join(work,'paper.json')),beforePaper);
    assert.deepEqual(fs.readFileSync(path.join(work,'qa-report.json')),beforeQa,'independent QA report remains available unchanged');

    const markup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'');
    for(const id of ['reader-status','check-report-open','check-report','check-report-summary','check-report-download']){
      assert.doesNotMatch(markup,new RegExp('\\bid\\s*=\\s*["\']'+id+'["\']','i'),'removed QA UI: '+id);
    }
    assert.doesNotMatch(markup,/acceptance-pending|synthetic-review-fingerprint|synthetic-renderer-fingerprint|\/synthetic\/path/);
    const buttons=[...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi)];
    const notesButton=buttons.filter(m=>attribute(m[1],'data-view')==='notes');
    assert.equal(notesButton.length,1);assert.equal(notesButton[0][2].trim(),'阅读笔记','fixed text, no count span');
    const pdfButton=buttons.filter(m=>attribute(m[1],'data-view')==='source');
    assert.equal(pdfButton.length,1);assert.match(pdfButton[0][2].trim(),/^原pdf$/i);
    // A hidden compatibility counter may exist outside the button. It is not
    // a dynamic badge in the reading toolbar.
    const counter=markup.match(/<span\b([^>]*\bid\s*=\s*["']note-count["'][^>]*)>/i);
    if(counter){assert.match(counter[1],/(?:^|\s)hidden(?:\s|$)/);assert.equal(attribute(counter[1],'aria-hidden'),'true');}
    assert.match(markup,/<iframe\b[^>]*\bid=["']source-pdf-frame["'][^>]*>/i);
    assert.match(markup,/\bid=["']source-pages["']/i);
    assert.match(markup,/<a\b[^>]*\bid=["']original-pdf["'][^>]*\bdownload=["']source\.pdf["']/i);
    assert.doesNotMatch(markup,/\bid=["'](?:source-image|page-select|source-zoom)["']/i,'obsolete single-page image controls are absent');

    const javascript=scripts.filter(m=>attribute(m[1],'type')!=='application/json');
    assert.ok(javascript.length>0);
    javascript.forEach((m,i)=>new vm.Script(m[2],{filename:'actual-inline-'+i+'.js'}));
    const code=javascript.map(m=>m[2]).join('\n');
    assert.doesNotMatch(code,/MicroPaperStatus|createStatus\(/,'compatibility status module is not loaded');
    for(const name of ['MicroPaperColumns','MicroPaperArticleInfo','MicroPaperPresentation','MicroPaperNotesState','MicroPaperToc','MicroPaperOriginalPdf','MicroPaperSelectionTools','MicroPaperReadingFont','MicroPaperArticleSearch','MicroPaperReferenceLinks'])assert.ok(code.includes(name),'actual module wired: '+name);
    assert.match(code,/sourcePdf\s*=\s*window\.MicroPaperOriginalPdf\.create\(/);
    assert.match(code,/sourcePdf\.showPage\(/);
    assert.match(code,/sourcePdf\?\.ensure\(/);
    assert.doesNotMatch(html,/__[A-Z][A-Z_]*__/,'all actual package slots resolved');
    const embedded=scripts.filter(m=>attribute(m[1],'id')==='embedded-notes');
    assert.equal(embedded.length,1);assert.equal(JSON.parse(embedded[0][2]),null);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
