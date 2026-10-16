// Node-only source-byte and DOM-contract tests. These do not claim native PDF
// rendering, scrolling pixels, image decoding or visual fit was browser-tested.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const pdf=require('../assets/reader/original-pdf.js');
const data=bytes=>'data:application/pdf;base64,'+Buffer.from(bytes).toString('base64');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sample=Buffer.from('%PDF-1.7\nSelf-authored unit byte fixture; not a rendering test.\n');
function pages(count=3){return Array.from({length:count},(_,i)=>({pageId:'source-page-'+(i+1),number:i+1,width:i%2?840:595,height:i%2?595:842,asset:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+(i%2?840:595)+'" height="'+(i%2?595:842)+'"><text x="10" y="25">Self-authored page '+(i+1)+'</text></svg>')}));}
function harness({viewer=true,count=3,sourcePdf=data(sample),urlError=false,pageList}={}){
 const created=[],revoked=[],scrolled=[],canceled=[],raf=new Map();let sequence=0;
 const doc={defaultView:null,createElement(tag){return new Element(tag)},getElementById(id){const find=e=>e.id===id?e:e.children.map(find).find(Boolean);return roots.map(find).find(Boolean)||null}};
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.hidden=true;this.children=[];this.dataset={};this.listeners=new Map();this.sourceChanges=[];this._src='';}
  set src(value){this._src=String(value);this.sourceChanges.push(this._src)}get src(){return this._src}
  append(...children){this.children.push(...children)}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn)}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn)}
  dispatch(type){for(const fn of [...(this.listeners.get(type)||[])])fn({target:this,type})}
  scrollIntoView(options){scrolled.push({id:this.id,options})}
 }
 const win={navigator:viewer===undefined?{}:{pdfViewerEnabled:viewer},URL:{createObjectURL(blob){if(urlError)throw Error('Synthetic Blob API failure');created.push(blob);return'blob:self-authored-'+created.length},revokeObjectURL(url){revoked.push(url)}},requestAnimationFrame(fn){const id=++sequence;raf.set(id,fn);return id},cancelAnimationFrame(id){canceled.push(id);raf.delete(id)}};
 doc.defaultView=win;
 const frame=new Element('iframe'),fallback=new Element('div'),loading=new Element('p'),downloadLink=new Element('a'),roots=[frame,fallback,loading,downloadLink];
 const paper={sourcePdf,pages:pageList||pages(count)},original=JSON.stringify(paper);
 const controller=pdf.create({paper,frame,fallback,loading,downloadLink});
 function flush(){const queued=[...raf];raf.clear();for(const [,fn]of queued)fn();}
 return{paper,original,controller,doc,win,frame,fallback,loading,downloadLink,created,revoked,scrolled,canceled,raf,flush};
}

test('sourceBlob round-trips every original byte across chunk boundaries',async()=>{
 const bytes=Buffer.concat([sample,Buffer.from(Array.from({length:100000},(_,i)=>i%256))]);
 const blob=pdf.sourceBlob(data(bytes)),restored=Buffer.from(await blob.arrayBuffer());
 assert.equal(blob.type,'application/pdf');assert.equal(blob.size,bytes.length);
 assert.deepEqual(restored,bytes);assert.equal(digest(restored),digest(bytes));
});
test('PDF signature within the first 1024 bytes does not strip leading source bytes',async()=>{
 const bytes=Buffer.concat([Buffer.alloc(512,0x20),sample]);
 assert.deepEqual(Buffer.from(await pdf.sourceBlob(data(bytes)).arrayBuffer()),bytes);
});
test('sourceBlob rejects non-PDF representations, malformed base64 and invalid signatures',()=>{
 for(const invalid of [null,undefined,{},42,'','%PDF-1.7','data:text/plain;base64,'+sample.toString('base64'),'data:application/pdf;base64,%%%%','data:application/pdf;base64,',data('This is not a PDF'),data('%PDF-without-a-version'),data(Buffer.concat([Buffer.alloc(1024,0x20),sample]))])assert.throws(()=>pdf.sourceBlob(invalid));
});
test('create requires all viewer elements before starting any source work',()=>{
 assert.throws(()=>pdf.create(),TypeError);assert.throws(()=>pdf.create({paper:{}}),TypeError);
});
test('creation is lazy and the download link preserves the exact source representation',async()=>{
 const h=harness();assert.equal(h.created.length,0);assert.equal(h.frame.src,'');assert.equal(h.fallback.children.length,0);
 assert.equal(h.downloadLink.href,h.paper.sourcePdf);assert.equal(h.downloadLink.download,'source.pdf');
 assert.deepEqual(Buffer.from(await pdf.sourceBlob(h.downloadLink.href).arrayBuffer()),sample);assert.equal(JSON.stringify(h.paper),h.original);
});
test('native ensure creates one offline Blob URL and load clears the loading state',async()=>{
 const h=harness();h.controller.ensure();assert.equal(h.created.length,1);assert.equal(h.frame.hidden,false);assert.equal(h.fallback.hidden,true);assert.equal(h.loading.hidden,false);
 assert.equal(h.frame.src,'blob:self-authored-1#view=FitH&navpanes=0');assert.equal(h.frame.dataset.viewerMode,'native-pdf');assert.equal(h.frame.dataset.pageCount,'3');
 h.controller.ensure();assert.equal(h.created.length,1);assert.deepEqual(Buffer.from(await h.created[0].arrayBuffer()),sample);
 h.frame.dispatch('load');assert.equal(h.loading.hidden,true);assert.equal(JSON.stringify(h.paper),h.original);
});
test('unavailable native viewer creates every fallback page exactly once in source order',()=>{
 const h=harness({viewer:false,count:42});h.controller.ensure();h.controller.ensure();h.controller.showFallback();
 assert.equal(h.created.length,0);assert.equal(h.frame.hidden,true);assert.equal(h.loading.hidden,true);assert.equal(h.fallback.hidden,false);assert.equal(h.fallback.dataset.viewerMode,'continuous-pages');assert.equal(h.fallback.children.length,42);
 for(const [index,section]of h.fallback.children.entries()){
  const page=h.paper.pages[index],[image,caption]=section.children;
  assert.equal(section.tagName,'FIGURE');assert.equal(section.dataset.pageId,page.pageId);assert.equal(section.id,'original-pdf-'+page.pageId);
  assert.equal(image.src,page.asset);assert.equal(image.width,page.width);assert.equal(image.height,page.height);assert.equal(image.loading,'lazy');assert.equal(image.decoding,'async');assert.equal(image.alt,'原 PDF 第 '+page.number+' 页');assert.equal(caption.textContent,page.number+' / 42');
 }
 assert.equal(JSON.stringify(h.paper),h.original);
});
test('fallback intrinsic dimensions and fit CSS preserve the aspect-ratio contract',()=>{
 const h=harness({viewer:false});h.controller.ensure();
 assert.deepEqual(h.fallback.children.map(s=>[s.children[0].width,s.children[0].height]),[[595,842],[840,595],[595,842]]);
 const css=fs.readFileSync(path.join(__dirname,'../assets/reader/style.css'),'utf8'),rule=css.match(/#source-view\s+\.source-page-image\s*\{([^}]+)\}/);
 assert(rule,'Fallback images need their own fit rule');assert(/(?:^|;)\s*width\s*:\s*auto\s*(?:;|$)/.test(rule[1]));assert(/(?:^|;)\s*height\s*:\s*auto\s*(?:;|$)/.test(rule[1]));assert(/max-width\s*:\s*100%/.test(rule[1]));
});
test('invalid PDF bytes or unavailable Blob API safely use all fallback pages',()=>{
 for(const options of [{sourcePdf:data('not PDF')},{sourcePdf:'data:application/pdf;base64,%%%'},{urlError:true}]){
  const h=harness(options);assert.doesNotThrow(()=>h.controller.ensure());assert.equal(h.created.length,0);assert.equal(h.frame.hidden,true);assert.equal(h.fallback.hidden,false);assert.equal(h.loading.hidden,true);assert.equal(h.fallback.children.length,3);
 }
});
test('native showPage uses the declared page number and repeated navigation remains effective',()=>{
 const h=harness({pageList:[{...pages(1)[0],pageId:'front',number:1},{...pages(2)[1],pageId:'appendix',number:9}]});
 h.controller.showPage('appendix');assert.equal(h.created.length,1);assert.match(h.frame.src,/#page=9&/);assert.equal(h.frame.dataset.targetPage,'9');const previous=h.frame.src;
 h.controller.showPage('appendix');assert.notEqual(h.frame.src,previous);assert.equal(h.created.length,2);
 h.controller.showPage('front');assert.match(h.frame.src,/#page=1&/);assert.equal(h.frame.dataset.targetPage,'1');
});
test('direct first showPage loads its target once without a default-page request',()=>{
 const h=harness();h.controller.showPage('source-page-2');
 assert.equal(h.frame.sourceChanges.length,1);assert.match(h.frame.sourceChanges[0],/#page=2&/);assert.equal(h.created.length,1);
 h.controller.ensure();assert.equal(h.frame.sourceChanges.length,1);
});
test('each native jump reloads a distinct resource URL while reusing the same decoded Blob',()=>{
 const h=harness();h.controller.showPage('source-page-2');h.controller.showPage('source-page-3');h.controller.showPage('source-page-1');
 assert.equal(h.created.length,3);assert.equal(new Set(h.created).size,1,'Original source bytes must not be decoded for every jump');
 assert.equal(new Set(h.frame.sourceChanges.map(src=>src.split('#')[0])).size,3,'Fragment-only navigation does not update the Chrome native PDF viewer');
 assert.deepEqual(h.frame.sourceChanges.map(src=>Number(src.match(/#page=(\d+)/)[1])),[2,3,1]);
});
test('legacy ensure then showPage still issues a fresh target resource without decoding twice',()=>{
 const h=harness();h.controller.ensure();h.controller.showPage('source-page-3');
 assert.equal(h.created.length,2);assert.equal(h.created[0],h.created[1]);assert.notEqual(h.frame.sourceChanges[0].split('#')[0],h.frame.src.split('#')[0]);assert.match(h.frame.src,/#page=3&/);
});
test('retired native URLs survive until replacement load and are revoked exactly once',()=>{
 const h=harness();h.controller.showPage('source-page-2');h.controller.showPage('source-page-3');
 assert.deepEqual(h.revoked,[],'Do not revoke the previous resource while the replacement iframe is starting');
 h.frame.dispatch('load');assert.deepEqual(h.revoked,['blob:self-authored-1']);
 h.frame.dispatch('load');assert.deepEqual(h.revoked,['blob:self-authored-1']);
 h.controller.showPage('source-page-1');h.frame.dispatch('load');assert.deepEqual(h.revoked,['blob:self-authored-1','blob:self-authored-2']);
 h.controller.destroy();h.controller.destroy();assert.deepEqual(h.revoked,['blob:self-authored-1','blob:self-authored-2','blob:self-authored-3']);
});
test('native error releases all resource URLs and retains the requested fallback target',()=>{
 const h=harness();h.controller.showPage('source-page-2');h.controller.showPage('source-page-3');h.frame.dispatch('error');h.flush();
 assert.deepEqual(h.revoked,['blob:self-authored-1','blob:self-authored-2']);assert.equal(h.scrolled.at(-1).id,'original-pdf-source-page-3');
 h.controller.destroy();assert.deepEqual(h.revoked,['blob:self-authored-1','blob:self-authored-2']);
});
test('unknown page IDs are no-ops before initialization and after valid navigation',()=>{
 const h=harness();h.controller.showPage('missing');assert.equal(h.created.length,0);assert.equal(h.frame.src,'');assert.equal(h.fallback.children.length,0);
 h.controller.showPage('source-page-2');const src=h.frame.src;h.controller.showPage('missing');assert.equal(h.frame.src,src);assert.equal(h.created.length,1);
});
test('fallback showPage scrolls the exact source page after rendering and coalesces rapid jumps',()=>{
 const h=harness({viewer:false});h.controller.showPage('source-page-2');h.controller.showPage('source-page-3');assert.equal(h.scrolled.length,0);assert.equal(h.raf.size,1);h.flush();
 assert.deepEqual(h.scrolled,[{id:'original-pdf-source-page-3',options:{block:'start'}}]);assert.equal(h.fallback.children.length,3);
});
test('native failure preserves the requested target page in the continuous fallback',()=>{
 const h=harness();h.controller.showPage('source-page-2');h.frame.dispatch('error');assert.equal(h.frame.hidden,true);assert.equal(h.fallback.hidden,false);assert.equal(h.fallback.children.length,3);h.flush();
 assert.deepEqual(h.scrolled,[{id:'original-pdf-source-page-2',options:{block:'start'}}]);h.controller.showPage('source-page-3');h.flush();assert.equal(h.scrolled.at(-1).id,'original-pdf-source-page-3');
});
test('destroy cancels queued scrolling and prevents subsequent public or event-driven mutations',()=>{
 const h=harness({viewer:false});h.controller.showPage('source-page-2');assert.equal(h.raf.size,1);h.controller.destroy();assert.equal(h.raf.size,0);const state=[h.frame.hidden,h.fallback.hidden,h.loading.hidden,h.fallback.children.length];
 h.flush();h.controller.ensure();h.controller.showPage('source-page-1');h.controller.showFallback();h.frame.dispatch('error');h.frame.dispatch('load');
 assert.equal(h.scrolled.length,0);assert.deepEqual([h.frame.hidden,h.fallback.hidden,h.loading.hidden,h.fallback.children.length],state);assert.equal(h.created.length,0);
});
test('native destroy revokes exactly its own Blob URL once and removes event listeners',()=>{
 const h=harness();h.controller.ensure();h.controller.destroy();h.controller.destroy();assert.deepEqual(h.revoked,['blob:self-authored-1']);assert.equal(h.frame.listeners.get('load').size,0);assert.equal(h.frame.listeners.get('error').size,0);h.controller.ensure();assert.equal(h.created.length,1);
});
test('destroy before first source visit allocates and revokes no Blob URL',()=>{
 const h=harness();h.controller.destroy();h.controller.ensure();h.controller.showPage('source-page-1');h.controller.showFallback();assert.equal(h.created.length,0);assert.equal(h.revoked.length,0);assert.equal(h.fallback.children.length,0);assert.equal(h.frame.src,'');
});
