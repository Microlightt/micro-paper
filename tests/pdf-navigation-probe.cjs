#!/usr/bin/env node
/* Self-authored, offline Chrome-native PDF navigation probe.
 * node tests/pdf-navigation-probe.cjs --out EVIDENCE_DIR [--helper FILE]
 *   [--chrome FILE] [--playwright MODULE] [--prepare-only]
 * Only the native viewer's page input determines success. Outer frame URLs,
 * attributes, and fixture event logs are diagnostic evidence, never page proof.
 */
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function options(argv){
 const o={};for(let i=0;i<argv.length;i++){
  const key=argv[i];if(key==='--prepare-only'){o.prepareOnly=true;continue;}
  if(!['--out','--helper','--chrome','--playwright'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Unknown or incomplete argument: '+key);
  o[key.slice(2)]=argv[++i];
 }
 if(!o.out)throw Error('Usage: node pdf-navigation-probe.cjs --out EVIDENCE_DIR [--helper FILE] [--chrome FILE] [--playwright MODULE] [--prepare-only]');
 return o;
}
function threePagePdf(){
 const objects=new Map();objects.set(1,'<< /Type /Catalog /Pages 2 0 R >>');
 objects.set(2,'<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>');
 objects.set(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 for(let n=1;n<=3;n++){
  const page=4+(n-1)*2,stream=page+1;
  const body='q\n0.94 0.97 1 rg\n30 30 552 732 re f\nQ\nBT\n/F1 54 Tf\n65 650 Td\n(PAGE '+n+') Tj\n/F1 16 Tf\n0 -55 Td\n(Self-authored offline navigation fixture) Tj\n0 -30 Td\n(Three pages. No user paper or user annotations.) Tj\nET\n';
  objects.set(page,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents '+stream+' 0 R >>');
  objects.set(stream,'<< /Length '+Buffer.byteLength(body)+' >>\nstream\n'+body+'endstream');
 }
 let text='%PDF-1.4\n% Self-authored PDF navigation probe\n';const offsets=[0];
 for(let id=1;id<=9;id++){offsets[id]=Buffer.byteLength(text);text+=id+' 0 obj\n'+objects.get(id)+'\nendobj\n';}
 const xref=Buffer.byteLength(text);text+='xref\n0 10\n0000000000 65535 f \n';
 for(let id=1;id<=9;id++)text+=String(offsets[id]).padStart(10,'0')+' 00000 n \n';
 text+='trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
 const bytes=Buffer.from(text);
 for(let id=1;id<=9;id++)if(bytes.subarray(offsets[id],offsets[id]+String(id).length+6).toString()!==id+' 0 obj')throw Error('Self-authored PDF xref mismatch');
 return bytes;
}
function fixtureHtml(pdf){
 const source='data:application/pdf;base64,'+pdf.toString('base64');
 return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline native PDF navigation probe</title><style>body{margin:0;font:15px system-ui;background:#eef1f5}header{padding:10px 16px;background:white}h1{font-size:17px;margin:0 0 8px}button{margin:3px;padding:7px 11px}iframe{display:block;width:calc(100vw - 24px);height:calc(100vh - 172px);margin:10px;border:1px solid #555;background:white}[hidden]{display:none!important}#fallback img{max-width:90vw}</style><header><h1>Self-authored three-page PDF: native page counter is the only page evidence</h1><div><button id="old-1">Old URL page 1</button><button id="old-2">Old URL page 2</button><button id="old-3">Old URL page 3</button><button id="fresh-2">Fresh URL page 2</button><button id="fresh-3">Fresh URL page 3</button><button id="fresh-1">Fresh URL page 1</button></div><div><button id="native-2">Helper direct page 2</button><button id="native-3">Helper page 3</button><button id="native-1">Helper page 1</button><button id="ensure-2">Helper ensure then page 2</button></div><span id="status">Ready</span></header><p id="loading" hidden>Loading native PDF</p><iframe id="pdf-frame" title="Self-authored original PDF" hidden></iframe><div id="fallback" hidden></div><a id="download" hidden>Fixture PDF</a><script src="./original-pdf-under-test.js"></script><script>\n'+
 '(()=>{\n'+
 'const source='+JSON.stringify(source)+';\n'+
 'const binary=atob(source.slice(source.indexOf(",")+1)),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));\n'+
 'const fixtureBlob=new Blob([bytes],{type:"application/pdf"});const frame=document.getElementById("pdf-frame"),events=[],urls=[];let oldUrl=null,jump=0;\n'+
 'const paper={sourcePdf:source,pages:[1,2,3].map(n=>({pageId:"page-"+n,number:n,width:612,height:792,asset:"data:image/svg+xml,"+encodeURIComponent("<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"612\\" height=\\"792\\"><text x=\\"50\\" y=\\"80\\">Self-authored page "+n+"</text></svg>")}))};\n'+
 'let controller;try{controller=MicroPaperOriginalPdf.create({paper,frame,fallback:document.getElementById("fallback"),loading:document.getElementById("loading"),downloadLink:document.getElementById("download")});}catch(error){events.push({error:String(error),strategy:"helper-init"});}\n'+
 'function go(strategy,n){try{if(strategy==="old"||strategy==="fresh"){frame.hidden=false;document.getElementById("fallback").hidden=true;let url;if(strategy==="old"){if(!oldUrl){oldUrl=URL.createObjectURL(fixtureBlob);urls.push(oldUrl);}url=oldUrl;}else{url=URL.createObjectURL(fixtureBlob);urls.push(url);}frame.src=url+"#page="+n+"&view=FitH&navpanes=0&navigation="+(++jump);events.push({strategy,requestedPage:n,url,blobReference:"single-fixture-blob",sameBlob:true,blobSize:fixtureBlob.size});}else{if(!controller)throw Error("Helper did not initialize");if(strategy==="ensure")controller.ensure();controller.showPage("page-"+n);events.push({strategy,requestedPage:n,outerSrc:frame.src});}document.getElementById("status").textContent=strategy+" requested page "+n;}catch(error){events.push({strategy,requestedPage:n,error:String(error)});}}\n'+
 'for(const n of [1,2,3]){document.getElementById("old-"+n).onclick=()=>go("old",n);document.getElementById("fresh-"+n).onclick=()=>go("fresh",n);document.getElementById("native-"+n).onclick=()=>go("helper",n);}document.getElementById("ensure-2").onclick=()=>go("ensure",2);\n'+
 'window.pdfProbe={ready:true,events,fixtureBlobSize:fixtureBlob.size};window.addEventListener("beforeunload",()=>{controller?.destroy();for(const url of urls)URL.revokeObjectURL(url);});\n'+
 '})();\n</script></html>';
}
async function nativeState(page){
 const frames=page.frames();
 for(const frame of frames){
  if(!frame.url().startsWith('chrome-extension:'))continue;
  try{
   for(const selector of ['viewer-page-selector input','#pageSelector']){
    const counter=frame.locator(selector).first();if(!await counter.count())continue;
    const value=await counter.inputValue({timeout:500});
    const native=await frame.evaluate(()=>{
     const all=[];function visit(root){for(const e of root.querySelectorAll('*')){all.push(e);if(e.shadowRoot)visit(e.shadowRoot);}}visit(document);
     const viewer=all.find(e=>e.localName==='pdf-viewer'),plugin=all.find(e=>e.localName==='embed');
     const fields={};for(const [label,e]of [['viewer',viewer],['plugin',plugin]])if(e){for(const key of ['originalUrl','originalUrl_','src']){try{if(typeof e[key]==='string')fields[label+'.'+key]=e[key];}catch(_){}}for(const attr of ['original-url','src'])if(e.hasAttribute(attr))fields[label+'['+attr+']']=e.getAttribute(attr);}
     const pageSelector=all.find(e=>e.localName==='viewer-page-selector');
     return {originalUrl:plugin?.getAttribute('original-url')||fields['viewer.originalUrl']||fields['viewer.originalUrl_']||null,urlFields:fields,totalText:(pageSelector?.shadowRoot?.textContent||pageSelector?.textContent||'').trim().slice(0,500)};
    });
    return{actualPage:Number(value)||null,counterValue:value,counterSelector:selector,nativeFrameUrl:frame.url(),...native};
   }
  }catch(_){/* Navigation can detach the old native frame. Retry the new frame. */}
 }
 return null;
}
async function observePage(page,expected){
 const started=Date.now(),observations=[];let last=null,matchingSince=null;
 while(Date.now()-started<8000){
  const native=await nativeState(page);
  if(native){last=native;if(observations.at(-1)?.actualPage!==native.actualPage||observations.at(-1)?.originalUrl!==native.originalUrl)observations.push({...native,elapsedMs:Date.now()-started});
   if(native.actualPage===expected){matchingSince??=Date.now();if(Date.now()-matchingSince>=250)return{...native,observed:true,matched:true,elapsedMs:Date.now()-started,observations};}else matchingSince=null;
  }
  await delay(100);
 }
 return{...(last||{}),observed:!!last,matched:false,elapsedMs:Date.now()-started,observations};
}
async function main(){
 const o=options(process.argv.slice(2)),out=path.resolve(o.out),helper=path.resolve(o.helper||path.join(__dirname,'../assets/reader/original-pdf.js'));
 await fs.mkdir(out,{recursive:true});
 const helperBytes=await fs.readFile(helper),pdf=threePagePdf(),html=fixtureHtml(pdf),htmlFile=path.join(out,'fixture.html');
 await Promise.all([fs.writeFile(path.join(out,'fixture.pdf'),pdf),fs.writeFile(htmlFile,html),fs.writeFile(path.join(out,'original-pdf-under-test.js'),helperBytes)]);
 const report={probe:'native-pdf-navigation',startedAt:new Date().toISOString(),nodeVersion:process.version,helper,helperSha256:sha(helperBytes),fixtureSha256:sha(pdf),fixtureHtmlSha256:sha(html),fixtureBytes:pdf.length,fixturePages:3,selfAuthored:true,offline:true,successEvidence:'Chrome native viewer-page-selector input / #pageSelector only',outerAttributeIsSuccessEvidence:false,cases:[],errors:[],consoleErrors:[],httpRequests:[],requestFailures:[],browserClosed:false};
 let browser;
 try{
  if(o.prepareOnly){report.preparedOnly=true;return;}
  const modulePath=o.playwright||process.env.PLAYWRIGHT_MODULE||'playwright';
  const pw=require(modulePath);report.playwrightModule=modulePath;
  browser=await pw.chromium.launch({headless:true,executablePath:o.chrome||process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});report.browserVersion=browser.version();
  const scenarios=[{name:'old-same-url-fragments',diagnostic:true,buttons:['old-1','old-2','old-3'],pages:[1,2,3]},{name:'fresh-url-same-blob',buttons:['fresh-2','fresh-3','fresh-1'],pages:[2,3,1]},{name:'helper-direct-first-page-2',buttons:['native-2','native-3','native-1'],pages:[2,3,1]},{name:'helper-ensure-before-first-page-2',buttons:['ensure-2','native-3','native-1'],pages:[2,3,1]}];
  for(const scenario of scenarios){
   const c={name:scenario.name,diagnostic:!!scenario.diagnostic,steps:[]};report.cases.push(c);
   const context=await browser.newContext({offline:true,viewport:{width:1280,height:1000}});
   try{
    const page=await context.newPage();page.setDefaultTimeout(8000);
    page.on('pageerror',e=>report.errors.push({case:c.name,error:e.stack||String(e)}));
    page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({case:c.name,error:m.text()});});
    page.on('request',r=>{if(/^https?:/i.test(r.url()))report.httpRequests.push({case:c.name,url:r.url()});});
    page.on('requestfailed',r=>report.requestFailures.push({case:c.name,url:r.url(),failure:r.failure()}));
    await page.goto(pathToFileURL(htmlFile).href);await page.waitForFunction(()=>window.pdfProbe?.ready);
    for(let i=0;i<scenario.buttons.length;i++){
     const button=scenario.buttons[i],expectedPage=scenario.pages[i],step={button,expectedPage};c.steps.push(step);
     try{
      await page.locator('#'+button).click();Object.assign(step,await observePage(page,expectedPage));
      step.fixtureEvent=await page.evaluate(()=>window.pdfProbe.events.at(-1));
      step.outerSrc=await page.locator('#pdf-frame').getAttribute('src');
      step.status=step.observed?(step.matched?'pass':scenario.diagnostic?'diagnostic-mismatch':'fail'):'blocked';
     }catch(error){step.status='blocked';step.error=error.stack||String(error);}
     step.screenshot=c.name+'-'+String(i+1)+'-requested-'+expectedPage+'.png';
     try{await page.screenshot({path:path.join(out,step.screenshot),fullPage:true});}catch(error){step.screenshotError=String(error);}
    }
    c.fixtureEvents=await page.evaluate(()=>window.pdfProbe.events);
    c.status=c.steps.some(s=>s.status==='blocked')?'blocked':c.steps.some(s=>s.status==='fail')?'fail':scenario.diagnostic?'diagnostic':'pass';
    if(scenario.diagnostic)c.interpretation=c.steps.some(s=>s.status==='diagnostic-mismatch')?'Same-URL fragment navigation mismatch reproduced by native counter.':'No same-URL fragment mismatch observed on this browser; do not assume a failure.';
   }catch(error){c.status='blocked';c.error=error.stack||String(error);}
   finally{await context.close().catch(error=>report.errors.push({case:c.name,closeError:String(error)}));}
  }
 }catch(error){report.fatal=error.stack||String(error);process.exitCode=1;}
 finally{
  if(browser){try{await browser.close();report.browserClosed=true;}catch(error){report.closeError=String(error);process.exitCode=1;}}
  report.finishedAt=new Date().toISOString();report.summary={pass:report.cases.filter(c=>c.status==='pass').length,diagnostic:report.cases.filter(c=>c.status==='diagnostic').length,fail:report.cases.filter(c=>c.status==='fail').length,blocked:report.cases.filter(c=>c.status==='blocked').length};
  if(report.httpRequests.length||report.errors.length||report.summary.fail||report.summary.blocked)process.exitCode=1;
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({out,helperSha256:report.helperSha256,fixtureSha256:report.fixtureSha256,summary:report.summary,preparedOnly:!!report.preparedOnly,browserClosed:report.browserClosed,fatal:report.fatal}));
 }
}
main().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
