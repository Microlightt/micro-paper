const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../assets/reader/article-search.js');

test('canonical bilingual results count occurrences, include captions, and keep source order', () => {
  const paper = {blocks:[
    {blockId:'caption-1',order:20,kind:'caption',en:'Serpin in Fig. 1. SERPIN.',zh:'图 1：Serpin。'},
    {blockId:'body-1',order:2,kind:'paragraph',en:'The serpin axis and a serpin.',zh:'丝氨酸蛋白酶抑制剂。'},
    {blockId:'header',order:1,kind:'header-footer',en:'Serpin',zh:'Serpin'},
    {blockId:'label',order:21,kind:'figure-label',en:'Serpin',zh:'Serpin'}
  ]};
  const before=JSON.stringify(paper),found=search.findMatches(paper,'serpin');
  assert.equal(found.length,5);
  assert.deepEqual(found.map(({blockId,language,start})=>[blockId,language,start]),[
    ['body-1','en',4],['body-1','en',22],['caption-1','en',0],['caption-1','en',18],['caption-1','zh',4]
  ]);
  for(const match of found){const block=paper.blocks.find(b=>b.blockId===match.blockId);assert.equal(block[match.language].slice(match.start,match.end),match.text)}
  assert.equal(JSON.stringify(paper),before);
});

test('punctuation is literal, so user input cannot inject regex or executable markup', () => {
  const special=['a+b','[a-z]','(p<0.05)','a.b','x*y','x?','{1,2}','^a$','a|b','\\d','</script><img onerror=1>'];
  for(const query of special){const text='prefix '+query+' suffix '+query;const found=search.occurrences(text,query);assert.equal(found.length,2,query);assert(found.every(match=>match.text===query))}
  assert.equal(search.occurrences('aaab aab ab','a+b').length,0);
  assert.deepEqual(search.occurrences('anything','['),[]);
});

test('Chinese, English case, supplementary characters and scientific Unicode use source UTF-16 offsets', () => {
  const text='🧬 Serpin SERPIN 肿瘤免疫 🧪serpin αΒγ';
  assert.deepEqual(search.occurrences(text,'SERPIN').map(m=>m.start),[3,10,24]);
  assert.deepEqual(search.occurrences(text,'肿瘤免疫'),[{start:17,end:21,text:'肿瘤免疫'}]);
  assert.deepEqual(search.occurrences(text,'🧪'),[{start:22,end:24,text:'🧪'}]);
  assert.equal(search.occurrences(text,'αβγ')[0].text,'αΒγ');
  assert.equal(search.occurrences('İ is not a one-unit case expansion','İ')[0].end,1);
});

test('search trims outer whitespace, does not invent fuzzy matches, and uses nonoverlapping occurrences', () => {
  assert.equal(search.occurrences(' serpin ','  serpin  ').length,1);
  assert.deepEqual(search.occurrences('banana','ana'),[{start:1,end:4,text:'ana'}]);
  assert.equal(search.occurrences('ababa','aba').length,1);
  assert.equal(search.occurrences('immune\nevasion','immune evasion').length,0);
  assert.equal(search.occurrences('immune evasion','免疫逃逸').length,0);
  for(const query of ['', '  ', '\n', null, undefined])assert.deepEqual(search.occurrences('source',query),[]);
  assert.deepEqual(search.occurrences(undefined,'x'),[]);
});

test('missing translations and arbitrary canonical IDs are safe without selector interpolation', () => {
  const blocks=[{blockId:'x"] #fake',kind:'paragraph',en:'search me',zh:null},{blockId:'empty',kind:'paragraph'}];
  assert.equal(search.findMatches(blocks,'search')[0].blockId,'x"] #fake');
  assert.deepEqual(search.findMatches({blocks},''),[]);
  assert.deepEqual(search.findMatches({},'search'),[]);
});

function textFixture(parts) {
  const nodes=parts.map(([nodeValue,parentTag])=>({nodeValue,parentTag}));
  const prose={textContent:nodes.map(n=>n.nodeValue).join('')};
  const doc={
    createTreeWalker(target,what){assert.equal(target,prose);assert.equal(what,4);let i=0;return{nextNode:()=>nodes[i++]||null}},
    createRange(){return{setStart(node,offset){this.startContainer=node;this.startOffset=offset},setEnd(node,offset){this.endContainer=node;this.endOffset=offset}}}
  };
  prose.ownerDocument=doc;
  return{prose,nodes};
}

test('range mapping crosses formatting and permanent annotation nodes without modifying them', () => {
  const {prose,nodes}=textFixture([['A ','P'],['ser','MARK'],['pin','EM'],[' axis','SUP']]);
  const snapshot=nodes.map(node=>({...node}));
  const index=search.textIndex(prose,'A serpin axis');
  const range=search.rangeFromIndex(index,2,8);
  assert.equal(range.startContainer,nodes[1]);assert.equal(range.startOffset,0);
  assert.equal(range.endContainer,nodes[2]);assert.equal(range.endOffset,3);
  assert.deepEqual(nodes,snapshot);assert.equal(prose.textContent,'A serpin axis');
  const entire=search.rangeFromIndex(index,0,index.length);
  assert.equal(entire.startContainer,nodes[0]);assert.equal(entire.startOffset,0);
  assert.equal(entire.endContainer,nodes[3]);assert.equal(entire.endOffset,5);
});

test('range mapping refuses stale or divergent canonical DOM rather than guessing an anchor', () => {
  const {prose}=textFixture([['Source text','MARK']]);
  assert.equal(search.textIndex(prose,'Changed source'),null);
  assert.equal(search.rangeFromIndex(null,0,3),null);
  const index=search.textIndex(prose,'Source text');
  for(const [start,end] of [[-1,2],[0,20],[2,2],[3,1],[.5,2],[0,Infinity]])assert.equal(search.rangeFromIndex(index,start,end),null);
});

test('range mapping protects surrogate pairs and skips empty formatting nodes', () => {
  const {prose,nodes}=textFixture([['A','P'],['','EM'],['🧬','MARK'],['B','P']]);
  const index=search.textIndex(prose,'A🧬B');
  assert.equal(index.length,4);assert.equal(index.nodes.length,3);
  assert.equal(search.rangeFromIndex(index,1,2),null);
  assert.equal(search.rangeFromIndex(index,2,3),null);
  const range=search.rangeFromIndex(index,1,3);
  assert.equal(range.startContainer,nodes[2]);assert.equal(range.startOffset,0);
  assert.equal(range.endContainer,nodes[2]);assert.equal(range.endOffset,2);
});
