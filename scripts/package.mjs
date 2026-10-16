import {readFile, realpath, mkdir, writeFile, rm, access} from 'node:fs/promises';
import {dirname, resolve, relative, extname, isAbsolute, sep} from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseExportOptions, renderFilename, previewNamedHtml, writeNamedHtml} from './export-name.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
if(!process.argv[2]) throw Error('A paper work directory is required');
const options=parseExportOptions(process.argv.slice(3));
async function main(){
const work=await realpath(process.argv[2]);
const lock=resolve(work,'.micro-paper-write.lock'),ownerPath=resolve(lock,'owner.json');
let owned=false,borrower=null,token=process.env.MICRO_PAPER_PARENT_LOCK_TOKEN;
if(token){
  const owner=JSON.parse(await readFile(ownerPath,'utf8'));
  if(owner.token!==token||owner.pid!==process.ppid||owner.hostname!==hostname())throw Error('Invalid parent writer lock');
}else{
  try{await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw Error('Article writer lock is held; package after the active writer finishes');throw error;}
  token=randomUUID();owned=true;
  try{await writeFile(ownerPath,JSON.stringify({pid:process.pid,operation:'package',createdAt:new Date().toISOString(),hostname:hostname(),token}));}catch(error){await rm(lock,{recursive:true,force:true});throw error;}
}
try{
  if(!owned){
    const recovering=async()=>{try{await access(resolve(lock,'recovery-claim'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
    if(await recovering())throw Error('Writer recovery is active');
    try{await mkdir(resolve(lock,'borrowers'));}catch(error){if(error.code!=='EEXIST')throw error;}
    const registration=resolve(lock,'borrowers',process.pid+'.json');
    await writeFile(registration,JSON.stringify({pid:process.pid,parentPid:process.ppid,hostname:hostname(),token}),{flag:'wx'});
    borrower=registration;
    if(await recovering())throw Error('Writer recovery is active');
    const owner=JSON.parse(await readFile(ownerPath,'utf8'));
    if(owner.token!==token||owner.pid!==process.ppid)throw Error('Parent writer changed during child registration');
  }
  for(const transaction of ['.translation-transaction','.source-transaction']){
    let pending=false;try{await access(resolve(work,transaction));pending=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(pending)throw Error('Unfinished '+(transaction==='.source-transaction'?'source':'translation')+' transaction; recover before packaging');
  }
const paper=JSON.parse(await readFile(resolve(work,'paper.json'),'utf8'));
paper.rendererVersion='1.6.0';
const date=options.date||new Date().toISOString().slice(0,10);
paper.readerSettings={...paper.readerSettings,generatedDate:date};
if(options.template!==undefined) paper.readerSettings.exportFilenameTemplate=options.template.trim()||'reader.html';
// Packaging without an explicit name keeps the legacy reader.html build path.
const naming=renderFilename(options.template===undefined?'reader.html':options.template,paper,date);
if(options.preview){console.log(JSON.stringify({status:'preview',...naming,...await previewNamedHtml(work,naming.filename),writes:false}));return}
const manifest=JSON.parse(await readFile(resolve(work,'source-manifest.json'),'utf8'));
const qa=JSON.parse(await readFile(resolve(work,'qa-report.json'),'utf8'));
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.pdf':'application/pdf'};
async function data(ref){
  const path=await realpath(resolve(work,ref));
  const rel=relative(work,path);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep)) throw Error('Asset outside workspace');
  if(!mime[extname(path)]) throw Error('Unsupported asset representation');
  return 'data:'+mime[extname(path)]+';base64,'+(await readFile(path)).toString('base64');
}
// Bounded reads preserve source bytes and resolution; no prior article cache.
const assets=[...paper.pages,...paper.figures];let assetCursor=0;
await Promise.all(Array.from({length:Math.min(4,Math.max(1,assets.length))},async()=>{while(assetCursor<assets.length){const asset=assets[assetCursor++];asset.asset=await data(asset.assetRef);}}));
paper.sourcePdf=await data('source.pdf');
// Preserve diagnostics as data; reading controls do not display a QA claim.
paper.qa=qa;
// Source checks accompany the exported reader without leaking filesystem paths or glyph dumps.
paper.coverage={pageCount:manifest.pageCount,components:await readFile(resolve(work,'review.json'),'utf8').then(JSON.parse).then(r=>r.components).catch(()=>({}))};
let html=await readFile(resolve(root,'assets/reader/index.html'),'utf8');
const css=await readFile(resolve(root,'assets/reader/style.css'),'utf8');
const js=await readFile(resolve(root,'assets/reader/reader.js'),'utf8');
const exportJs=await readFile(resolve(root,'assets/reader/export-name.js'),'utf8');
const imageJs=await readFile(resolve(root,'assets/reader/image-interactions.js'),'utf8');
const articleJs=await readFile(resolve(root,'assets/reader/article-info.js'),'utf8');
const columnsJs=await readFile(resolve(root,'assets/reader/column-layout.js'),'utf8');
const columnsCss=await readFile(resolve(root,'assets/reader/column-layout.css'),'utf8');
const articleCss=await readFile(resolve(root,'assets/reader/article-info.css'),'utf8');
const notesStateJs=await readFile(resolve(root,'assets/reader/notes-state.js'),'utf8');
const tocJs=await readFile(resolve(root,'assets/reader/toc.js'),'utf8');
const originalPdfJs=await readFile(resolve(root,'assets/reader/original-pdf.js'),'utf8');
const presentationJs=await readFile(resolve(root,'assets/reader/reader-presentation.js'),'utf8');
const selectionJs=await readFile(resolve(root,'assets/reader/selection-tools.js'),'utf8');
const selectionCss=await readFile(resolve(root,'assets/reader/selection-tools.css'),'utf8');
const readingFontJs=await readFile(resolve(root,'assets/reader/reading-font.js'),'utf8');
const readingFontCss=await readFile(resolve(root,'assets/reader/reading-font.css'),'utf8');
const searchJs=await readFile(resolve(root,'assets/reader/article-search.js'),'utf8');
const searchCss=await readFile(resolve(root,'assets/reader/article-search.css'),'utf8');
const referenceJs=await readFile(resolve(root,'assets/reader/reference-links.js'),'utf8');
const referenceCss=await readFile(resolve(root,'assets/reader/reference-links.css'),'utf8');
const serialized=JSON.stringify(paper).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const slots=new Map([['__STYLE__',css],['__COLUMNS_STYLE__',columnsCss],['__ARTICLE_INFO_STYLE__',articleCss],['__PAPER__',serialized],['__EXPORT_SCRIPT__',exportJs],['__IMAGE_SCRIPT__',imageJs],['__ARTICLE_INFO_SCRIPT__',articleJs],['__COLUMNS_SCRIPT__',columnsJs],['__NOTES_STATE_SCRIPT__',notesStateJs],['__TOC_SCRIPT__',tocJs],['__ORIGINAL_PDF_SCRIPT__',originalPdfJs],['__PRESENTATION_SCRIPT__',presentationJs],['__SELECTION_SCRIPT__',selectionJs],['__SELECTION_STYLE__',selectionCss],['__READING_FONT_SCRIPT__',readingFontJs],['__READING_FONT_STYLE__',readingFontCss],['__SEARCH_SCRIPT__',searchJs],['__SEARCH_STYLE__',searchCss],['__REFERENCE_SCRIPT__',referenceJs],['__REFERENCE_STYLE__',referenceCss],['__SCRIPT__',js]]);
const found=[...html.matchAll(/__[A-Z][A-Z_]*__/g)].map(match=>match[0]);
if(found.length!==slots.size||new Set(found).size!==slots.size||found.some(key=>!slots.has(key)))throw Error('Template slots missing, duplicated or unknown');
// Fill the original small template in one traversal, avoiding repeated copies
// of the large embedded PDF and page/figure assets. Literal data is never parsed
// again as a slot, even when it contains a slot-like string.
html=html.replace(/__[A-Z][A-Z_]*__/g,key=>slots.get(key));
if(/https?:\/\//.test(css+columnsCss+articleCss+js+exportJs+imageJs+articleJs+columnsJs+notesStateJs+tocJs+originalPdfJs+presentationJs+selectionJs+selectionCss+readingFontJs+readingFontCss+searchJs+searchCss+referenceJs+referenceCss)) throw Error('Reader code must not depend on network URLs');
const output=await writeNamedHtml(work,naming.filename,html);
console.log(JSON.stringify({status:'packaged',...output,date,bytes:Buffer.byteLength(html),pages:paper.pages.length,figures:paper.figures.length}));

}finally{
  if(borrower)await rm(borrower,{force:true});
  if(owned){const owner=JSON.parse(await readFile(ownerPath,'utf8'));if(owner.token===token)await rm(lock,{recursive:true,force:true});}
}
}
await main();
