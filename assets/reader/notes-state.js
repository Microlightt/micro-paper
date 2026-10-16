(function(global,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(global) global.MicroPaperNotesState=api;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const COLORS=Object.freeze(['yellow','blue','green','pink','orange']);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const text=value=>typeof value==='string'&&value.length>0;
  const markers=value=>Array.isArray(value)?[...new Set(value.filter(text))]:[];
  const contentKeys=['blockId','language','start','end','quote','prefix','suffix','color','note','createdAt','updatedAt','sourceSha256','sourceDocumentId'];

  function sanitizeAnnotation(a){
    if(!isObject(a)||!text(a.annotationId)||!text(a.blockId)||!['en','zh'].includes(a.language)||!text(a.quote)||typeof a.note!=='string'||typeof a.textHash!=='string'||typeof a.prefix!=='string'||typeof a.suffix!=='string'||!Number.isInteger(a.start)||!Number.isInteger(a.end)||a.start<0||a.end<=a.start||a.end-a.start!==a.quote.length||!COLORS.includes(a.color)||typeof a.createdAt!=='string'||typeof a.updatedAt!=='string') throw Error('笔记字段或选区不合法');
    const result={annotationId:a.annotationId,blockId:a.blockId,language:a.language,start:a.start,end:a.end,quote:a.quote,prefix:a.prefix,suffix:a.suffix,textHash:a.textHash,color:a.color,note:a.note,createdAt:a.createdAt,updatedAt:a.updatedAt,status:a.status==='located'?'located':'unresolved'};
    for(const key of ['sourceSha256','sourceDocumentId','conflictOf','reason']) {
      if(a[key]!==undefined&&typeof a[key]!=='string')throw Error('笔记来源或状态字段不合法');
      if(typeof a[key]==='string')result[key]=a[key];
    }
    return result;
  }
  function equalAnnotation(a,b){return contentKeys.every(key=>a[key]===b[key]);}
  function validateEnvelope(envelope){
    if(!isObject(envelope)||envelope.format!=='micro-paper-notes'||envelope.schemaVersion!==1||!text(envelope.documentId)||!text(envelope.sourceSha256)||typeof envelope.contentFingerprint!=='string'||!Array.isArray(envelope.annotations)) throw Error('不支持的备份格式或缺少来源身份');
    if(envelope.snapshotId!==undefined&&!text(envelope.snapshotId)) throw Error('笔记快照标记不合法');
    if(envelope.embeddedSnapshots!==undefined&&(!Array.isArray(envelope.embeddedSnapshots)||envelope.embeddedSnapshots.some(value=>!text(value)))) throw Error('笔记快照记录不合法');
    return envelope;
  }
  function createEnvelope({paper,annotations=[],exportedAt,embeddedSnapshots=[],snapshotId}={}){
    if(!isObject(paper)||!text(paper.documentId)||!text(paper.sourceSha256)||typeof paper.contentFingerprint!=='string'||!Array.isArray(annotations)) throw Error('缺少笔记来源身份');
    const result={format:'micro-paper-notes',schemaVersion:1,documentId:paper.documentId,sourceSha256:paper.sourceSha256,contentFingerprint:paper.contentFingerprint,exportedAt:typeof exportedAt==='string'?exportedAt:new Date().toISOString(),annotations:annotations.map(sanitizeAnnotation),embeddedSnapshots:markers(embeddedSnapshots)};
    if(snapshotId!==undefined){if(!text(snapshotId))throw Error('笔记快照标记不合法');result.snapshotId=snapshotId;}
    return result;
  }
  function stableSuffix(value){let hash=2166136261;for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619);return(hash>>>0).toString(16);}
  function conflictId(annotation,seen,uid){
    if(typeof uid==='function')for(let i=0;i<8;i++){const id=uid();if(text(id)&&!seen.has(id))return id;}
    const base=annotation.annotationId+'~conflict-'+stableSuffix(JSON.stringify(contentKeys.map(key=>annotation[key])));
    let id=base,index=2;while(seen.has(id))id=base+'-'+index++;return id;
  }
  async function mergeEnvelopes({paper,embedded=null,local=null,locate,uid,appliedSnapshots=[],retryUnresolved=false}={}){
    if(!isObject(paper)||!text(paper.documentId)||!text(paper.sourceSha256)) throw Error('缺少笔记来源身份');
    const result={annotations:[],duplicates:0,conflicts:0,unresolved:0,errors:[],embeddedSnapshots:markers(appliedSnapshots)};
    const seen=new Map();
    let localEnvelope=null,embeddedEnvelope=null;
    function envelope(value,source){
      if(value===null||value===undefined)return null;
      try{return validateEnvelope(value);}catch(error){result.errors.push({source,code:'invalid-envelope'});return null;}
    }
    localEnvelope=envelope(local,'local');embeddedEnvelope=envelope(embedded,'embedded');
    let validLocalRecords=false;
    if(localEnvelope)try{localEnvelope.annotations.forEach(sanitizeAnnotation);validLocalRecords=true;}catch(error){}
    if(validLocalRecords&&localEnvelope.documentId===paper.documentId&&localEnvelope.sourceSha256===paper.sourceSha256)result.embeddedSnapshots=markers([...result.embeddedSnapshots,...markers(localEnvelope.embeddedSnapshots)]);
    async function resolve(raw,backup,source){
      let a;
      try{a=sanitizeAnnotation(raw);}catch(error){result.errors.push({source,code:'invalid-annotation',annotationId:typeof raw?.annotationId==='string'?raw.annotationId:undefined});return null;}
      a.sourceSha256=a.sourceSha256||backup.sourceSha256;a.sourceDocumentId=a.sourceDocumentId||backup.documentId;
      const unresolved=reason=>({...a,status:'unresolved',reason});
      if(backup.sourceSha256!==paper.sourceSha256||backup.documentId!==paper.documentId||a.sourceSha256!==paper.sourceSha256||a.sourceDocumentId!==paper.documentId)return unresolved('来源或论文身份不同，原记录保留');
      if(a.status==='unresolved'&&!retryUnresolved)return unresolved(a.reason||'位置尚未核实，原记录保留');
      if(typeof locate!=='function')return unresolved('位置尚未核实，原记录保留');
      try{
        const located=sanitizeAnnotation(await locate(clone(a),clone(backup)));
        // The locator may adjust verified anchors, never user note text, colour or identity.
        return {...a,blockId:located.blockId,start:located.start,end:located.end,textHash:located.textHash,status:located.status,...(located.reason===undefined?{reason:undefined}:{reason:located.reason})};
      }catch(error){result.errors.push({source,code:'location-check-failed',annotationId:a.annotationId});return unresolved('位置核验失败，原记录保留');}
    }
    async function append(backup,source){
      const before=result.errors.length;
      for(const raw of backup.annotations){
        let a=await resolve(raw,backup,source);if(!a)continue;
        const old=seen.get(a.annotationId);
        if(old){
          const equivalent=[...seen.values()].some(item=>(item.annotationId===a.annotationId||item.conflictOf===a.annotationId)&&equalAnnotation(item,a));
          if(equivalent){result.duplicates++;continue;}
          const original=a.annotationId;a={...a,annotationId:conflictId(a,seen,uid),conflictOf:original};result.conflicts++;
        }
        result.annotations.push(a);seen.set(a.annotationId,a);
      }
      return result.errors.length===before;
    }
    // Current local records take priority. Embedded differences become explicit copies.
    if(localEnvelope)await append(localEnvelope,'local');
    const snapshotId=embeddedEnvelope?.snapshotId;
    if(embeddedEnvelope&&(!snapshotId||!result.embeddedSnapshots.includes(snapshotId))){
      const complete=await append(embeddedEnvelope,'embedded');
      if(snapshotId&&complete)result.embeddedSnapshots=markers([...result.embeddedSnapshots,snapshotId]);
    }
    result.unresolved=result.annotations.filter(a=>a.status!=='located').length;
    return result;
  }
  return {COLORS,sanitizeAnnotation,equalAnnotation,validateEnvelope,createEnvelope,mergeEnvelopes};
});
