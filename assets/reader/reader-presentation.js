/* Display indexes only. Canonical strings, IDs, provenance and ranges stay intact. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MicroPaperPresentation=api})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.trim().replace(/\s+/g,' ')===b.trim().replace(/\s+/g,' ');
 function createIndex(paper){
  const blocks=new Map(paper.blocks.map(b=>[b.blockId,b])),figures=new Map(paper.figures.map(f=>[f.figureId,f]));
  const captions=paper.blocks.filter(b=>b.kind==='caption').sort((a,b)=>a.order-b.order),owners=new Map(captions.map(b=>[b.blockId,[]]));
  for(const f of paper.figures)for(const id of f.captionBlockIds||[])if(owners.has(id)&&!owners.get(id).includes(f.figureId))owners.get(id).push(f.figureId);
  // A caption's cross-references do not establish ownership. Fallback only to a verified
  // leading figure header followed by a caption delimiter; disagreeing languages stay unassigned.
  for(const b of captions)if(!owners.get(b.blockId).length){
   const prefixes=paper.inlineReferences.filter(r=>{
    const text=b[r.language];return r.blockId===b.blockId&&typeof text==='string'&&Number.isInteger(r.start)&&Number.isInteger(r.end)&&r.start>=0&&r.end>r.start&&text.slice(0,r.start).trim()===''&&text.slice(r.start,r.end)===r.exactText&&/^\s*[|:：.]/.test(text.slice(r.end));
   }).map(r=>[...new Set(r.figureIds.filter(id=>figures.has(id)))].sort()).filter(ids=>ids.length);
   if(prefixes.length&&prefixes.every(ids=>JSON.stringify(ids)===JSON.stringify(prefixes[0])))owners.set(b.blockId,prefixes[0]);
  }
  const visibleBlocks=s=>s.blockIds.map(id=>blocks.get(id)).filter(b=>b&&!['header-footer','figure-label'].includes(b.kind));
  function matchingHeading(section){const b=visibleBlocks(section).find(b=>b.kind==='heading');return b&&same(b.en,section.titleEn)&&same(b.zh,section.titleZh)?b:null}
  function captionOnly(section){const bs=visibleBlocks(section);return bs.length>0&&bs.every(b=>b.kind==='caption')}
  function sectionTarget(section){if(captionOnly(section))return visibleBlocks(section)[0].blockId;return matchingHeading(section)?.blockId||section.sectionId}
  return{captions,captionOwners:owners,matchingHeading,captionOnly,sectionTarget,captionIdsForFigure:id=>captions.filter(b=>owners.get(b.blockId).includes(id)).map(b=>b.blockId),ownersFor:id=>owners.get(id)||[],blocks};
 }
 return{createIndex,sameTitle:same};
});
