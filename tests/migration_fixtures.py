"""Deliberately modified synthetic readers, kept draft, for note migration regressions."""
import argparse
import copy
import shutil
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import reader as r


def make(source, output):
    original=r.read(source/'paper.json')
    science=next(b for b in original['blocks'] if all(any(f['blockId']==b['blockId'] and f['language']=='en' and f['kind']==kind for f in original['formatting']) for kind in ['italic','sup','sub']))
    for kind in ['revised','ambiguous','split','style']:
        work=output/kind
        if work.exists():raise ValueError('New fixture directory required')
        shutil.copytree(source,work,ignore=shutil.ignore_patterns('browser*','translation','reader.html','review*.json'))
        p=copy.deepcopy(original);b=next(b for b in p['blocks'] if b['blockId']==science['blockId'])
        if kind=='revised':b['en']='Updated '+b['en']
        if kind=='ambiguous':b['en']='Changed '+b['en']+'\n'+b['en']
        if kind=='style':p['formatting']=[]
        if kind=='split':
            old=copy.deepcopy(b);b['blockId']=old['blockId']+'-remainder';b['en']=old['en'][4:];b['zh']='';b['translationStatus']='pending';b['sourceSpans']=old['sourceSpans'][4:]
            prefix=copy.deepcopy(old);prefix['blockId']=old['blockId']+'-prefix';prefix['en']=old['en'][:4];prefix['zh']='';prefix['translationStatus']='pending';prefix['sourceSpans']=old['sourceSpans'][:4]
            p['blocks'].insert(p['blocks'].index(b),prefix)
            for i,block in enumerate(p['blocks']):block['order']=i
            for s in p['sections']:
                if old['blockId'] in s['blockIds']:
                    i=s['blockIds'].index(old['blockId']);s['blockIds'][i:i+1]=[prefix['blockId'],b['blockId']]
            for f in p['formatting']:
                if f['blockId']==old['blockId']:f['blockId']=b['blockId'];f['start']-=4;f['end']-=4
            p['formatting']=[f for f in p['formatting'] if f['language']=='en' and f['start']>=0]
            p['idMap'].append({'oldBlockId':old['blockId'],'newBlockId':b['blockId'],'language':'en','oldStart':4,'oldEnd':r.u16len(old['en']),'newStart':0,'newEnd':r.u16len(b['en']),'oldText':b['en'],'newText':b['en']})
        p['sourceEdits'].append({'blockId':science['blockId'],'before':science['en'],'after':b['en'],'reason':'Deliberate synthetic migration test, draft only','sourceEvidence':'Self-authored synthetic fixture mutation'})
        r.write(work/'paper.json',p);r.freeze(work);r.build(work,True)
    return output


if __name__=='__main__':
    cli=argparse.ArgumentParser();cli.add_argument('source',type=Path);cli.add_argument('output',type=Path);a=cli.parse_args();print(make(a.source,a.output))
