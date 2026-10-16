const test=require('node:test');
const assert=require('node:assert/strict');
const notes=require('../assets/reader/notes-state.js');
const paper=()=>({documentId:'self-authored-paper',sourceSha256:'a'.repeat(64),contentFingerprint:'b'.repeat(64),blocks:[{blockId:'body',en:'A😀BC sample',zh:'甲😀乙样例'}],idMap:[]});
const annotation=(extra={})=>({annotationId:'note-a',blockId:'body',language:'en',start:0,end:1,quote:'A',prefix:'',suffix:'😀BC sample',textHash:'c'.repeat(64),color:'yellow',note:'Self-authored unit note',createdAt:'2024-01-01T00:00:00.000Z',updatedAt:'2024-01-01T00:00:00.000Z',status:'located',...extra});
const envelope=(p,annotations,extra={})=>({...notes.createEnvelope({paper:p,annotations,exportedAt:'2024-01-01T00:00:00.000Z'}),...extra});
const locate=async a=>({...a,status:'located',textHash:'verified-text-hash'});

test('all five colours round-trip outside canonical paper data',async()=>{
  const p=paper(),before=JSON.stringify(p);
  const records=notes.COLORS.map((color,i)=>annotation({annotationId:'colour-'+i,color}));
  const snapshot=envelope(p,records,{snapshotId:'export-1'});
  const reopened=await notes.mergeEnvelopes({paper:p,embedded:JSON.parse(JSON.stringify(snapshot)),local:null,locate});
  assert.deepEqual(reopened.annotations.map(a=>a.color),['yellow','blue','green','pink','orange']);
  assert.deepEqual(reopened.embeddedSnapshots,['export-1']);
  assert.equal(JSON.stringify(p),before);
  assert(!Object.hasOwn(p,'annotations'));
});
test('empty localStorage on another file restores embedded note, colour and UTF-16 anchors',async()=>{
  const p=paper(),a=annotation({start:1,end:3,quote:'😀',prefix:'A',suffix:'BC sample',color:'green'});
  const e=envelope(p,[a],{snapshotId:'emoji-export'}),before=JSON.stringify(e);
  const reopened=await notes.mergeEnvelopes({paper:p,embedded:e,local:null,locate:async record=>{assert.equal(p.blocks[0].en.slice(record.start,record.end),record.quote);return record;}});
  assert.equal(reopened.annotations[0].start,1);assert.equal(reopened.annotations[0].end,3);assert.equal(reopened.annotations[0].quote.length,2);
  assert.equal(reopened.annotations[0].color,'green');assert.equal(reopened.annotations[0].note,a.note);assert.equal(JSON.stringify(e),before);
});
test('embedded snapshot listing its own applied marker still restores on a fresh machine',async()=>{
  const p=paper(),embedded=envelope(p,[annotation({color:'blue'})],{snapshotId:'marked-at-confirm',embeddedSnapshots:['marked-at-confirm']});
  const reopened=await notes.mergeEnvelopes({paper:p,embedded,local:null,locate});
  assert.equal(reopened.annotations.length,1);assert.equal(reopened.annotations[0].color,'blue');assert.deepEqual(reopened.embeddedSnapshots,['marked-at-confirm']);
});
test('legacy v1 envelope without snapshot metadata remains supported and deduplicates',async()=>{
  const p=paper(),legacy=envelope(p,[annotation()]);delete legacy.embeddedSnapshots;
  const result=await notes.mergeEnvelopes({paper:p,embedded:legacy,local:legacy,locate});
  assert.equal(result.annotations.length,1);assert.equal(result.duplicates,1);assert.equal(result.conflicts,0);
});
test('true same-ID differences retain local data and preserve embedded conflict copy',async()=>{
  const p=paper(),local=envelope(p,[annotation({color:'blue',note:'Current local edit'})]);
  const embedded=envelope(p,[annotation({color:'yellow',note:'Exported earlier edit'})],{snapshotId:'older-export'});
  const result=await notes.mergeEnvelopes({paper:p,embedded,local,locate,uid:()=> 'conflict-copy'});
  assert.equal(result.annotations.length,2);assert.equal(result.conflicts,1);
  assert.deepEqual(result.annotations.map(a=>[a.annotationId,a.color,a.note]),[['note-a','blue','Current local edit'],['conflict-copy','yellow','Exported earlier edit']]);
  assert.equal(result.annotations[1].conflictOf,'note-a');
});
test('an already retained equivalent conflict is not repeatedly copied',async()=>{
  const p=paper(),embedded=envelope(p,[annotation({note:'Old'})]);
  const first=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,[annotation({note:'New'})]),locate,uid:()=> 'conflict-copy'});
  const second=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,first.annotations),locate});
  assert.equal(second.annotations.length,2);assert.equal(second.conflicts,0);assert.equal(second.duplicates,1);
});
test('applied snapshot does not resurrect a deletion when local annotations are empty',async()=>{
  const p=paper(),embedded=envelope(p,[annotation()],{snapshotId:'snapshot-applied'});
  const first=await notes.mergeEnvelopes({paper:p,embedded,local:null,locate});
  const afterDeletion=envelope(p,[],{embeddedSnapshots:first.embeddedSnapshots});
  const reopened=await notes.mergeEnvelopes({paper:p,embedded,local:afterDeletion,locate});
  assert.deepEqual(reopened.annotations,[]);assert.equal(reopened.conflicts,0);assert.deepEqual(reopened.embeddedSnapshots,['snapshot-applied']);
});
test('applied snapshot does not resurrect old colour or create conflict after local recolouring',async()=>{
  const p=paper(),embedded=envelope(p,[annotation()],{snapshotId:'colour-snapshot'});
  const first=await notes.mergeEnvelopes({paper:p,embedded,local:null,locate});
  const edited=first.annotations.map(a=>({...a,color:'blue',updatedAt:'2024-01-02T00:00:00.000Z'}));
  const reopened=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,edited,{embeddedSnapshots:first.embeddedSnapshots}),locate});
  assert.equal(reopened.annotations.length,1);assert.equal(reopened.annotations[0].color,'blue');assert.equal(reopened.conflicts,0);
});
test('explicit appliedSnapshots guard works for caller-generated stable legacy snapshot IDs',async()=>{
  const p=paper(),embedded=envelope(p,[annotation()],{snapshotId:'content-derived-id'});
  const result=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,[]),appliedSnapshots:['content-derived-id'],locate});
  assert.deepEqual(result.annotations,[]);assert.deepEqual(result.embeddedSnapshots,['content-derived-id']);
});
test('foreign source or document never reaches locator and remains unresolved across export/reopen',async()=>{
  const p=paper();let calls=0;
  for(const foreign of [{documentId:'different-document'},{sourceSha256:'f'.repeat(64)}]){
    const backup=envelope(p,[annotation()],foreign);
    const result=await notes.mergeEnvelopes({paper:p,embedded:backup,locate:async a=>{calls++;return a;}});
    assert.equal(result.annotations[0].status,'unresolved');
    assert.equal(result.annotations[0].sourceDocumentId,backup.documentId);
    const exported=envelope(p,result.annotations,{snapshotId:'foreign-preserved'});
    const reopened=await notes.mergeEnvelopes({paper:p,embedded:exported,locate:async a=>{calls++;return a;}});
    assert.equal(reopened.annotations[0].status,'unresolved');
  }
  assert.equal(calls,0);
});
test('foreign local snapshot markers cannot suppress matching embedded data',async()=>{
  const p=paper(),local=envelope(p,[],{documentId:'foreign',embeddedSnapshots:['our-snapshot']});
  const result=await notes.mergeEnvelopes({paper:p,local,embedded:envelope(p,[annotation()],{snapshotId:'our-snapshot'}),locate});
  assert.equal(result.annotations.length,1);assert.equal(result.annotations[0].status,'located');
});
test('corrupt local records cannot use snapshot markers to suppress a valid embedded copy',async()=>{
  const p=paper(),local={...envelope(p,[]),annotations:[{annotationId:'broken-record'}],embeddedSnapshots:['safe-snapshot']};
  const result=await notes.mergeEnvelopes({paper:p,local,embedded:envelope(p,[annotation()],{snapshotId:'safe-snapshot'}),locate});
  assert.equal(result.annotations.length,1);assert.equal(result.annotations[0].annotationId,'note-a');assert.equal(result.errors[0].code,'invalid-annotation');
});
test('unresolved v1 notes are retained until an explicit verified retry',async()=>{
  const p=paper(),local=envelope(p,[annotation({status:'unresolved',reason:'Ambiguous original location'})]);let calls=0;
  const locator=async a=>{calls++;return {...a,status:'located',reason:undefined};};
  const first=await notes.mergeEnvelopes({paper:p,local,locate:locator});
  assert.equal(first.unresolved,1);assert.equal(calls,0);
  const retried=await notes.mergeEnvelopes({paper:p,local,locate:locator,retryUnresolved:true});
  assert.equal(retried.unresolved,0);assert.equal(calls,1);
});
test('locator contract preserves verified idMap anchors and all note content',async()=>{
  const p=paper();p.idMap=[{oldBlockId:'old-body',newBlockId:'body',language:'en',oldStart:0,oldEnd:3,newStart:0,newEnd:3,oldText:'A😀',newText:'A😀'}];
  const record=annotation({blockId:'old-body',start:1,end:3,quote:'😀',prefix:'A',color:'green'});
  const result=await notes.mergeEnvelopes({paper:p,local:envelope(p,[record],{contentFingerprint:'previous-content'}),locate:async(a,backup)=>{
    assert.equal(backup.contentFingerprint,'previous-content');assert.equal(a.start,1);assert.equal(a.end,3);
    const mapping=p.idMap[0];assert.equal(mapping.oldText,mapping.newText);assert.equal(mapping.oldText.slice(a.start,a.end),a.quote);
    return {...a,blockId:mapping.newBlockId,textHash:'verified-mapped-hash',status:'located',note:'Locator must not overwrite user note',color:'yellow'};
  }});
  assert.equal(result.annotations[0].blockId,'body');assert.equal(result.annotations[0].start,1);assert.equal(result.annotations[0].end,3);
  assert.equal(result.annotations[0].color,'green');assert.equal(result.annotations[0].note,record.note);assert.equal(result.annotations[0].textHash,'verified-mapped-hash');
});
test('corrupt records produce structured errors without dropping valid local notes or marking a snapshot applied',async()=>{
  const p=paper(),bad={...annotation(),color:'red'};
  const result=await notes.mergeEnvelopes({paper:p,local:envelope(p,[annotation()]),embedded:{...envelope(p,[]),snapshotId:'invalid-snapshot',annotations:[bad]},locate});
  assert.equal(result.annotations.length,1);assert.deepEqual(result.embeddedSnapshots,[]);
  assert.equal(result.errors[0].source,'embedded');assert.equal(result.errors[0].code,'invalid-annotation');
  assert.throws(()=>notes.sanitizeAnnotation(bad),/不合法/);
});
test('locator errors retain note as unresolved and never leak exception objects',async()=>{
  const p=paper(),result=await notes.mergeEnvelopes({paper:p,local:envelope(p,[annotation()]),locate:async()=>{throw Error('private diagnostic');}});
  assert.equal(result.annotations[0].status,'unresolved');assert.equal(result.annotations[0].note,annotation().note);
  assert.equal(result.errors[0].code,'location-check-failed');assert(!JSON.stringify(result.errors).includes('private diagnostic'));
});
test('malformed explicit provenance is rejected rather than silently replaced by current identity',async()=>{
  const p=paper();let calls=0;
  const result=await notes.mergeEnvelopes({paper:p,local:{...envelope(p,[]),annotations:[annotation({sourceDocumentId:{unexpected:true}})]},locate:async a=>{calls++;return a;}});
  assert.equal(calls,0);assert.equal(result.annotations.length,0);assert.equal(result.errors[0].code,'invalid-annotation');
});
test('conflict ID fallback stays unique when an injected UID collides',async()=>{
  const p=paper(),result=await notes.mergeEnvelopes({paper:p,local:envelope(p,[annotation()]),embedded:envelope(p,[annotation({note:'Other'})]),locate,uid:()=> 'note-a'});
  assert.equal(new Set(result.annotations.map(a=>a.annotationId)).size,2);assert.equal(result.conflicts,1);
});

// Extending the palette must not weaken the previous snapshot application guard.
test('new colours survive fresh export/reopen, recolouring and deletion without snapshot resurrection',async()=>{
  const p=paper();
  for(const color of ['pink','orange']){
    const embedded=envelope(p,[annotation({color,note:'New palette note '+color})],{snapshotId:'new-'+color});
    const first=await notes.mergeEnvelopes({paper:p,embedded:JSON.parse(JSON.stringify(embedded)),local:null,locate});
    assert.equal(first.annotations[0].color,color);assert.equal(first.annotations[0].note,'New palette note '+color);
    const recolored=first.annotations.map(a=>({...a,color:color==='pink'?'orange':'pink',updatedAt:'2024-01-02T00:00:00.000Z'}));
    const edited=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,recolored,{embeddedSnapshots:first.embeddedSnapshots}),locate});
    assert.equal(edited.annotations.length,1);assert.equal(edited.annotations[0].color,recolored[0].color);assert.equal(edited.conflicts,0);
    const deleted=await notes.mergeEnvelopes({paper:p,embedded,local:envelope(p,[],{embeddedSnapshots:edited.embeddedSnapshots}),locate});
    assert.deepEqual(deleted.annotations,[]);
  }
});
test('legacy three-colour records remain accepted without schema migration',async()=>{
  const p=paper(),legacy=envelope(p,['yellow','blue','green'].map(color=>annotation({annotationId:color,color})));
  delete legacy.embeddedSnapshots;
  const reopened=await notes.mergeEnvelopes({paper:p,local:legacy,locate});
  assert.deepEqual(reopened.annotations.map(a=>a.color),['yellow','blue','green']);
  assert.equal(reopened.errors.length,0);assert.equal(legacy.schemaVersion,1);
});
