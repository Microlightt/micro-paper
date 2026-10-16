const assert=require('node:assert/strict');
const {summarize,serializeReport,createStatus}=require('../assets/reader/reader-status.js');

const paper=()=>({rendererVersion:'1.2.0',sourceSha256:'a'.repeat(64),reviewScopes:{paragraphRepair:{status:'pass',label:'PRIVATE BLOCK ID',evidence:['Self-authored unit fixture proof']},fullScientificReview:{status:'not-performed',label:'PRIVATE PATH'}},qa:{content:{status:'pass',errors:[],blocked:[]},browser:{status:'pass',checks:[]},overall:{status:'pass'}}});
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}

test('successful targeted repair does not claim scientific review',()=>{
  const summary=summarize(paper());
  assert.equal(summary.status,'partial');
  assert.match(summary.shortText,/段落修复已核查/);
  assert.match(summary.shortText,/全文科学审校未执行/);
  assert.equal(summary.shortText,'段落修复已核查 · 全文科学审校未执行');
  assert.match(summary.items.map(item=>item.text).join(' '),/机器检查已通过/);
  assert.match(summary.items.map(item=>item.text).join(' '),/浏览器检查已完成/);
  assert.doesNotMatch(JSON.stringify(summary),/PRIVATE|Self-authored/);
});
test('only all evidenced scopes and both checks can claim complete',()=>{
  const p=paper();p.reviewScopes.fullScientificReview={status:'pass',evidence:'Synthetic scope test, not real research'};
  assert.equal(summarize(p).status,'pass');
  p.reviewScopes.fullScientificReview.evidence=' ';
  assert.equal(summarize(p).status,'partial');
  assert.match(summarize(p).shortText,/全文科学审校未记录/);
});
test('missing, error and unrecognized states use neutral fixed text',()=>{
  const p=paper();p.qa.content={status:'error',errors:[{blockId:'secret-block',path:'/private/secret',debug:{unexpected:true}}]};
  p.qa.browser={status:{blocked:'/private/file'},reason:'secret reason'};
  p.reviewScopes={fullScientificReview:{status:'alien',label:'secret-label',evidence:'secret-evidence'}};
  assert.equal(summarize(p).status,'partial');
  assert.doesNotMatch(JSON.stringify(summarize(p)),/secret|private|unexpected|alien/);
  assert.equal(summarize(null).status,'partial');
  assert.equal(summarize({reviewScopes:{fullScientificReview:{status:'not-performed'}}}).shortText,'全文科学审校未执行');
  assert.doesNotMatch(summarize({}).shortText,/段落修复未记录|机器检查|浏览器检查/);
});
test('explicit failures remain visible without showing raw diagnostics',()=>{
  const p=paper();p.qa.content={status:'fail',errors:['Unreviewed translation secret-block']};
  assert.equal(summarize(p).status,'fail');
  assert.match(summarize(p).shortText,/检查需处理/);
  assert.match(summarize(p).items.find(item=>item.key==='machine').text,/机器检查需处理/);
  assert.doesNotMatch(summarize(p).shortText,/Unreviewed|secret/);
});
test('structured QA and legacy issue strings round-trip in JSON only',()=>{
  const p=paper(),issue={type:'acceptance-pending',blockId:'synthetic-block',detail:{codes:[1,2],path:'/synthetic/path'}};
  p.qa.content.blocked=[issue,'legacy issue'];p.issues=[issue];
  const before=JSON.stringify(p),report=JSON.parse(serializeReport(p));
  assert.deepEqual(report.qa.content.blocked,[issue,'legacy issue']);
  assert.deepEqual(report.reviewScopes,p.reviewScopes);
  assert.deepEqual(report.issues,[issue]);
  assert.equal(JSON.stringify(p),before);
  assert.doesNotMatch(serializeReport(p),/\[object Object\]/);
});

class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.handlers={};this._text='';this.open=false;}
  set textContent(value){this._text=value;this.children=[];}get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}replaceChildren(...children){this._text='';this.children=[...children];}
  setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this.attributes[key];}
  addEventListener(event,handler){(this.handlers[event]||=[]).push(handler);}removeEventListener(event,handler){this.handlers[event]=(this.handlers[event]||[]).filter(value=>value!==handler);}
  click(){(this.handlers.click||[]).forEach(handler=>handler());}showModal(){this.open=true;}close(){this.open=false;}
}
test('dialog and download render safe summaries and retain structured detail',()=>{
  const ids=['reader-status','check-report','check-report-summary','check-report-open','check-report-close','check-report-download'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element('div')]));
  elements['reader-status'].hidden=true;
  const doc={getElementById:id=>elements[id],createElement:tag=>new Element(tag)};
  const p=paper();p.qa.content={status:'blocked',errors:[],blocked:[{type:'acceptance-pending',path:'/private/secret',blockId:'secret-block'}]};
  let download;const ui=createStatus({paper:p,document:doc,download:(name,body,mime)=>download={name,body,mime}});
  ui.render();ui.render();
  assert.equal(elements['reader-status'].hidden,false);
  assert.equal(elements['check-report-summary'].children.length,3);
  assert.doesNotMatch(elements['reader-status'].textContent+elements['check-report-summary'].textContent,/acceptance|private|secret|\[object Object\]/);
  elements['check-report-open'].click();assert.equal(elements['check-report'].open,true);
  elements['check-report-close'].click();assert.equal(elements['check-report'].open,false);
  elements['check-report-download'].click();assert.equal(download.name,'reader-check-report.json');assert.equal(download.mime,'application/json');
  assert.deepEqual(JSON.parse(download.body).qa.content.blocked,p.qa.content.blocked);
  ui.destroy();assert.equal(elements['check-report-open'].handlers.click.length,0);
});
test('headless summary use has no DOM requirement',()=>{const ui=createStatus({paper:paper()});assert.equal(ui.render().status,'partial');assert.equal(JSON.parse(ui.downloadReport()).qa.browser.status,'pass');});
console.log(`${count} reader status unit tests passed`);
