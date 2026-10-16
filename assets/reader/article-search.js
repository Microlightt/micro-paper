/* Local canonical-text search. Paint Ranges without wrapping or rewriting article text. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MicroPaperArticleSearch=api})(typeof globalThis!=='undefined'?globalThis:this,function(){'use strict';
 const ALL='micro-paper-search',ACTIVE='micro-paper-search-active';
 const excluded=new Set(['figure-label','header-footer']);
 const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const normalizedQuery=value=>typeof value==='string'?value.trim():'';
 function occurrences(text,query){
  query=normalizedQuery(query);if(typeof text!=='string'||!query)return[];
  // Escaping makes punctuation literal; Unicode matching keeps source UTF-16 offsets.
  const pattern=new RegExp(escapePattern(query),'giu'),found=[];let match;
  while((match=pattern.exec(text))!==null)found.push({start:match.index,end:match.index+match[0].length,text:match[0]});
  return found;
 }
 function findMatches(paper,query){
  query=normalizedQuery(query);if(!query)return[];const found=[];
  const blocks=(Array.isArray(paper)?paper:paper?.blocks||[]).filter(Boolean).map((block,index)=>({block,index,order:Number.isFinite(block.order)?block.order:index}));
  blocks.sort((a,b)=>a.order-b.order||a.index-b.index);
  for(const {block}of blocks){if(!block||excluded.has(block.kind))continue;
   for(const language of ['en','zh'])for(const match of occurrences(block[language],query))found.push({blockId:block.blockId,language,kind:block.kind,...match});
  }return found;
 }
 function textIndex(prose,expectedText){
  if(!prose||typeof prose.textContent!=='string'||expectedText!==undefined&&prose.textContent!==expectedText)return null;
  const doc=prose.ownerDocument,walker=doc.createTreeWalker(prose,4),nodes=[];let node,start=0;
  while((node=walker.nextNode())){const length=node.nodeValue.length;if(length){nodes.push({node,start,end:start+length});start+=length}}
  return{prose,doc,nodes,length:start,text:prose.textContent};
 }
 function rangeFromIndex(index,start,end){
  if(!index||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>index.length)return null;
  // Annotation and search coordinates share canonical UTF-16 boundaries, never half a surrogate.
  if([start,end].some(i=>i>0&&i<index.length&&/[\uD800-\uDBFF]/.test(index.text[i-1])&&/[\uDC00-\uDFFF]/.test(index.text[i])))return null;
  function locate(offset,isEnd){let low=0,high=index.nodes.length-1;while(low<=high){const middle=(low+high)>>1,item=index.nodes[middle];if(offset<item.start||isEnd&&offset===item.start)high=middle-1;else if(offset>item.end||!isEnd&&offset===item.end)low=middle+1;else return{node:item.node,offset:offset-item.start}}return null}
  const from=locate(start,false),to=locate(end,true);if(!from||!to)return null;
  const range=index.doc.createRange();range.setStart(from.node,from.offset);range.setEnd(to.node,to.offset);return range;
 }
 function create({paper,container,root,reveal=()=>{},onClear=()=>{},onLayout=()=>{}}){
  if(!container)throw new Error('Search requires a toolbar container');
  const doc=container.ownerDocument,win=doc.defaultView;root=root||doc;
  const frame=callback=>win.requestAnimationFrame(callback),cancel=id=>win.cancelAnimationFrame(id);
  const blocks=new Map((paper.blocks||[]).map(block=>[block.blockId,block]));
  const cssMode=!!(win.CSS?.highlights&&typeof win.Highlight==='function');
  let query='',matches=[],current=-1,revision=0,refreshFrame=0,navigateFrame=0,overlayFrame=0,composing=false,destroyed=false;
  let painted=[],activeProse=null,overlay=null;
  const listeners=[];
  function listen(target,name,callback,options){target.addEventListener(name,callback,options);listeners.push(()=>target.removeEventListener(name,callback,options))}
  function element(tag,cls,text){const node=doc.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node}
  container.classList.add('article-search');container.setAttribute('role','search');container.setAttribute('aria-label','本地文章搜索');container.dataset.searchMode=cssMode?'css-highlight':'overlay';
  const label=element('label','search-label','搜索中英文全文');label.htmlFor='search';
  const input=element('input');input.id='search';input.type='search';input.placeholder='搜索中英文全文…';input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-label','搜索中英文全文');input.setAttribute('aria-describedby','search-status');
  const status=element('output','search-status');status.id='search-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
  function button(id,label,text){const node=element('button','search-button',text);node.id=id;node.type='button';node.title=label;node.setAttribute('aria-label',label);return node}
  const previous=button('search-previous','上一处匹配','↑'),next=button('search-next','下一处匹配','↓'),clear=button('search-clear','清空搜索','×');
  container.replaceChildren(label,input,status,previous,next,clear);
  function updateControls(){
   status.textContent=query?(matches.length?`${current+1} / ${matches.length}`:'0 / 0'):'';
   status.setAttribute('aria-label',query?(matches.length?`第 ${current+1} 处，共 ${matches.length} 处匹配`:'没有匹配'): '');
   previous.disabled=next.disabled=!matches.length;clear.disabled=!input.value;
   container.dataset.searchCount=String(matches.length);container.dataset.searchIndex=String(current);container.classList.toggle('has-query',!!query);
  }
  function removePaint(){
   if(cssMode){win.CSS.highlights.delete(ALL);win.CSS.highlights.delete(ACTIVE)}
   overlay?.replaceChildren();painted=[];
   if(activeProse){activeProse.classList.remove('search-reveal-duplicate');activeProse=null}
  }
  function proseMap(){const map=new Map();for(const prose of root.querySelectorAll('.prose[data-block-id][data-language]')){let languages=map.get(prose.dataset.blockId);if(!languages)map.set(prose.dataset.blockId,languages=new Map());languages.set(prose.dataset.language,prose)}return map}
  function refreshNow(){
   if(destroyed)return;removePaint();if(!query||!matches.length)return;
   const map=proseMap(),indexes=new Map();
   const active=matches[current];activeProse=map.get(active?.blockId)?.get(active?.language)||null;
   // Metadata sometimes shares duplicate text visually. Reveal only this temporary target.
   activeProse?.classList.add('search-reveal-duplicate');
   for(let i=0;i<matches.length;i++){
    const match=matches[i],prose=map.get(match.blockId)?.get(match.language);if(!prose)continue;
    if(!indexes.has(prose))indexes.set(prose,textIndex(prose,blocks.get(match.blockId)?.[match.language]));
    const range=rangeFromIndex(indexes.get(prose),match.start,match.end);if(range)painted.push({range,prose,active:i===current});
   }
   if(cssMode){
    const all=new win.Highlight(),selected=new win.Highlight();all.priority=1;selected.priority=2;
    for(const item of painted){all.add(item.range);if(item.active)selected.add(item.range)}
    win.CSS.highlights.set(ALL,all);win.CSS.highlights.set(ACTIVE,selected);
   }else paintOverlay();
  }
  function refresh(){if(destroyed||refreshFrame)return;refreshFrame=frame(()=>{refreshFrame=0;refreshNow()})}
  function toolbarBottom(){const toolbar=container.closest('.toolbar');return Math.max(0,toolbar?.getBoundingClientRect().bottom||0)}
  function clippedRect(rect,prose){
   let left=Math.max(0,rect.left),right=Math.min(win.innerWidth,rect.right),top=Math.max(toolbarBottom(),rect.top),bottom=Math.min(win.innerHeight,rect.bottom);
   for(let parent=prose.parentElement;parent&&parent!==doc.body;parent=parent.parentElement){const style=win.getComputedStyle(parent);if(/auto|scroll|hidden|clip/.test(style.overflowX+' '+style.overflowY)){const bounds=parent.getBoundingClientRect();left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom)}}
   return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;
  }
  function paintOverlay(){
   if(cssMode||destroyed)return;
   if(!overlay){overlay=element('div','search-range-overlay');overlay.setAttribute('aria-hidden','true');doc.body.append(overlay)}
   overlay.replaceChildren();if(!query)return;
   const visibility=new Map();
   for(const item of painted){
    if(!visibility.has(item.prose)){const rect=item.prose.getBoundingClientRect();visibility.set(item.prose,rect.width>0&&rect.height>0&&rect.bottom>toolbarBottom()&&rect.top<win.innerHeight)}
    if(!visibility.get(item.prose))continue;
    for(const rect of item.range.getClientRects()){const clipped=clippedRect(rect,item.prose);if(!clipped)continue;const mark=element('span','search-range-rect'+(item.active?' is-active':''));for(const [key,value]of Object.entries(clipped))mark.style[key]=value+'px';overlay.append(mark)}
   }
  }
  function queueOverlay(){if(cssMode||overlayFrame||destroyed)return;overlayFrame=frame(()=>{overlayFrame=0;paintOverlay()})}
  function scrollActive(){
   const item=painted.find(item=>item.active);if(!item)return;
   let rect=[...item.range.getClientRects()].find(rect=>rect.width>0&&rect.height>0);if(!rect)return;
   const pane=item.prose.closest('#figure-pane');
   if(pane){const bounds=pane.getBoundingClientRect(),controls=pane.querySelector('.figure-controls'),top=bounds.top+(controls?.getBoundingClientRect().height||0)+12,bottom=bounds.bottom-12;if(rect.top<top||rect.bottom>bottom)pane.scrollTop+=rect.top-top;rect=[...item.range.getClientRects()].find(rect=>rect.width>0&&rect.height>0)||rect}
   const top=toolbarBottom()+16,bottom=win.innerHeight-24;
   if(rect.top<top||rect.bottom>bottom)win.scrollBy({top:rect.top-top-Math.max(0,(bottom-top-rect.height)/3),behavior:'instant'});
   queueOverlay();
  }
  function navigate(){
   const token=++revision,match=matches[current];if(!match){refresh();return}
   // reveal may rerender both languages or switch/open a caption pane. Its own frame
   // runs first; a second layout boundary then scrolls the precise occurrence.
   Promise.resolve(reveal({...match})).then(()=>{
    if(destroyed||token!==revision)return;
    if(navigateFrame)cancel(navigateFrame);navigateFrame=frame(()=>{navigateFrame=frame(()=>{navigateFrame=0;if(destroyed||token!==revision)return;refreshNow();scrollActive()})});
   }).catch(()=>{if(!destroyed&&token===revision)refresh()});
  }
  function setQuery(value,{navigate:shouldNavigate=true}={}){
   if(destroyed)return;const oldQuery=query;input.value=typeof value==='string'?value:'';query=normalizedQuery(input.value);matches=findMatches(paper,query);current=matches.length?0:-1;revision++;removePaint();updateControls();
   if(!query){if(oldQuery)onClear();onLayout();return}
   if(shouldNavigate&&matches.length)navigate();else refresh();onLayout();
  }
  function step(amount){if(!matches.length||destroyed)return;current=(current+amount+matches.length)%matches.length;updateControls();navigate()}
  function clearSearch(){setQuery('');input.focus({preventScroll:true})}
  listen(input,'compositionstart',()=>{composing=true});listen(input,'compositionend',()=>{composing=false;setQuery(input.value)});
  listen(input,'input',event=>{if(!composing&&!event.isComposing)setQuery(input.value)});
  listen(input,'search',()=>{if(!input.value&&query)setQuery('')});
  listen(input,'keydown',event=>{if(composing||event.isComposing)return;if(event.key==='Enter'){event.preventDefault();step(event.shiftKey?-1:1)}else if(event.key==='Escape'){event.preventDefault();clearSearch()}});
  listen(previous,'click',()=>step(-1));listen(next,'click',()=>step(1));listen(clear,'click',clearSearch);
  if(!cssMode){listen(win,'scroll',queueOverlay,true);listen(win,'resize',queueOverlay);if(win.visualViewport){listen(win.visualViewport,'resize',queueOverlay);listen(win.visualViewport,'scroll',queueOverlay)}}
  updateControls();
  return{setQuery,refresh,next:()=>step(1),previous:()=>step(-1),clear:clearSearch,getState:()=>({query,total:matches.length,current,match:matches[current]?{...matches[current]}:null}),destroy(){destroyed=true;revision++;[refreshFrame,navigateFrame,overlayFrame].forEach(id=>{if(id)cancel(id)});listeners.forEach(remove=>remove());removePaint();overlay?.remove();container.replaceChildren()}};
 }
 return{create,findMatches,occurrences,textIndex,rangeFromIndex,highlightNames:{all:ALL,active:ACTIVE}};
});
