(function(global,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(global) global.MicroPaperStatus=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';

  const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const hasEvidence=value=>typeof value==='string'&&!!value.trim()||Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==='string'&&!!item.trim());
  const scopeStatus=scope=>{
    const status=object(scope).status;
    if(status==='pass'&&!hasEvidence(object(scope).evidence)) return 'unknown';
    return ['pass','fail','blocked','pending','not-performed','unknown'].includes(status)?status:'unknown';
  };
  const checkStatus=check=>['pass','fail','blocked'].includes(object(check).status)?check.status:'unknown';
  const wording={
    paragraphRepair:{pass:'段落修复已核查',fail:'段落修复需检查',blocked:'段落修复待核查',pending:'段落修复待核查','not-performed':'段落修复未执行',unknown:'段落修复未记录'},
    fullScientificReview:{pass:'全文科学审校已完成',fail:'全文科学审校需检查',blocked:'全文科学审校待完成',pending:'全文科学审校待完成','not-performed':'全文科学审校未执行',unknown:'全文科学审校未记录'},
    machine:{pass:'机器检查已通过',fail:'机器检查需处理',blocked:'机器检查待完成',unknown:'机器检查未记录'},
    browser:{pass:'浏览器检查已完成',fail:'浏览器检查需处理',blocked:'浏览器检查未完成',unknown:'浏览器检查未记录'}
  };

  function summarize(paper){
    paper=object(paper);
    const qa=object(paper.qa);
    const scopes=object(paper.reviewScopes===undefined?qa.reviewScopes:paper.reviewScopes);
    const statuses={paragraphRepair:scopeStatus(scopes.paragraphRepair),fullScientificReview:scopeStatus(scopes.fullScientificReview),machine:checkStatus(qa.content),browser:checkStatus(qa.browser)};
    const scopeStates=Object.values(scopes).map(scopeStatus);
    const status=statuses.machine==='fail'||statuses.browser==='fail'||scopeStates.includes('fail')?'fail':statuses.machine==='pass'&&statuses.browser==='pass'&&statuses.fullScientificReview==='pass'&&scopeStates.every(s=>s==='pass')?'pass':'partial';
    const items=[
      {key:'paragraphRepair',label:'段落修复',status:statuses.paragraphRepair,text:wording.paragraphRepair[statuses.paragraphRepair]},
      {key:'fullScientificReview',label:'全文科学审校',status:statuses.fullScientificReview,text:wording.fullScientificReview[statuses.fullScientificReview]},
      {key:'machine',label:'机器检查',status:statuses.machine,text:wording.machine[statuses.machine]},
      {key:'browser',label:'浏览器检查',status:statuses.browser,text:wording.browser[statuses.browser]}
    ];
    const shortItems=items.filter(item=>['paragraphRepair','fullScientificReview'].includes(item.key)&&Object.prototype.hasOwnProperty.call(scopes,item.key)).map(item=>item.text);
    if(status==='fail') shortItems.push('检查需处理');
    if(!shortItems.length) shortItems.push(status==='pass'?'检查已完成':'检查状态待核查');
    return {status,headline:status==='pass'?'检查已完成':status==='fail'?'检查需处理':'检查部分完成',shortText:shortItems.join(' · '),items};
  }

  function serializeReport(paper){
    paper=object(paper);
    return JSON.stringify({schemaVersion:1,rendererVersion:paper.rendererVersion,sourceSha256:paper.sourceSha256,reviewScopes:paper.reviewScopes===undefined?object(paper.qa).reviewScopes||{}:paper.reviewScopes,qa:object(paper.qa),issues:paper.issues===undefined?[]:paper.issues},null,2)+'\n';
  }

  function createStatus(options){
    options=object(options);
    const paper=options.paper, doc=options.document||(typeof document==='object'?document:null);
    const find=id=>doc&&doc.getElementById?doc.getElementById(id):null;
    const short=options.statusElement||find('reader-status'), dialog=options.dialog||find('check-report'), report=options.reportElement||find('check-report-summary');
    const openButton=options.openButton||find('check-report-open'), closeButton=options.closeButton||find('check-report-close'), downloadButton=options.downloadButton||find('check-report-download');
    const make=options.node||((tag,text,cls)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;});
    const listeners=[];
    function listen(element,event,handler){if(element&&element.addEventListener){element.addEventListener(event,handler);listeners.push([element,event,handler]);}}
    function open(){if(!dialog)return;if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else dialog.setAttribute('open','');}
    function close(){if(!dialog)return;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
    function downloadReport(){
      const body=serializeReport(paper),name='reader-check-report.json',mime='application/json';
      if(typeof options.download==='function') options.download(name,body,mime);
      else if(doc&&typeof Blob==='function'&&typeof URL==='function'&&URL.createObjectURL){
        const url=URL.createObjectURL(new Blob([body],{type:mime})),anchor=doc.createElement('a');anchor.href=url;anchor.download=name;anchor.click();URL.revokeObjectURL(url);
      }
      return body;
    }
    function render(){
      const summary=summarize(paper);
      if(short){short.hidden=false;short.textContent=summary.shortText;short.setAttribute('data-status',summary.status);}
      if(report){
        report.replaceChildren();
        report.append(make('p',summary.headline,'check-report-headline'));
        const list=make('ul');
        summary.items.forEach(item=>{const row=make('li',item.text);row.setAttribute('data-check',item.key);row.setAttribute('data-status',item.status);list.append(row);});
        report.append(list,make('p','各项状态分别记录。机器检查和浏览器检查通过，仍不能替代全文科学审校。详细记录可下载为 JSON。','check-report-explanation'));
      }
      return summary;
    }
    listen(openButton,'click',open);listen(closeButton,'click',close);listen(downloadButton,'click',downloadReport);
    return {render,open,close,downloadReport,destroy(){listeners.forEach(([element,event,handler])=>element.removeEventListener(event,handler));}};
  }

  return {summarize,serializeReport,createStatus};
});
