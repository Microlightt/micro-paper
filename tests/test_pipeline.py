"""Run with the extraction runtime: python -m unittest discover -s tests -v."""
import copy
import json
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import reader as r
from make_samples import make


class Contracts(unittest.TestCase):
    def test_compound_reference_scopes_targets_and_panels(self):
        refs=r.parse_references('😀 Figs. 1a–d, 2 and Extended Data Figs. 3b and 4c.')
        self.assertEqual(refs[0]['figureIds'],['main:1','main:2'])
        self.assertEqual(refs[0]['panelLabels'],['a','b','c','d'])
        self.assertEqual(refs[0]['start'],3)
        self.assertEqual(refs[0]['targets'][1]['figureIds'],['main:2'])
        self.assertEqual(refs[1]['figureIds'],['extended:3','extended:4'])
        self.assertEqual(r.parse_references('图 1 和 2，扩展数据图 3b、4c。')[1]['figureIds'],['extended:3','extended:4'])

    def test_utf16_ranges_reject_split_surrogate(self):
        self.assertEqual(r.u16len('a😀b'),4)
        r.validate_range('a😀b',1,3)
        with self.assertRaises(UnicodeError):r.validate_range('a😀b',1,2)

    def test_letter_only_panel_continuations_and_wrapped_scope(self):
        refs=r.parse_references('Fig. 1c,d and Extended Data\nFig. 4a,b. Figs. 2a, c–e and 3b, d.')
        self.assertEqual(refs[0]['panelLabels'],['c','d'])
        self.assertEqual(refs[0]['targets'][1]['figureIds'],['main:1'])
        self.assertEqual(refs[1]['figureIds'],['extended:4'])
        self.assertEqual(refs[1]['panelLabels'],['a','b'])
        self.assertEqual(refs[2]['figureIds'],['main:2','main:3'])
        self.assertEqual(refs[2]['panelLabels'],['a','c','d','e','b'])
        self.assertEqual(r.parse_references('图1a，b及扩展数据图2c、d。')[0]['panelLabels'],['a','b'])
        self.assertEqual(r.parse_references('Fig. 1 and control cells')[0]['exactText'],'Fig. 1')

    def test_fingerprint_preserves_style_and_changes_text(self):
        p={'blocks':[{'blockId':'stable','order':0,'en':'Text','zh':'原文'}]}
        before=r.fingerprint(p);p['formatting']=[{'kind':'italic'}]
        self.assertEqual(before,r.fingerprint(p));p['blocks'][0]['zh']='改动'
        self.assertNotEqual(before,r.fingerprint(p))

    def test_article_info_source_mapping_validation(self):
        p={"sections":[{"sectionId":"info","blockIds":["doi","authors"]}],"blocks":[{"blockId":"doi","kind":"body"},{"blockId":"authors","kind":"body"}],"articleInfo":{"sectionIds":["info"],"fields":[{"key":"doi","labelEn":"DOI","labelZh":"DOI","blockIds":["doi"]}]}}
        self.assertEqual(r.validate_article_info(p),[])
        bad=copy.deepcopy(p);bad["articleInfo"]["fields"].append({"key":"other","labelEn":"Other","labelZh":"其他","blockIds":["doi"]})
        self.assertTrue(r.validate_article_info(bad))
        bad=copy.deepcopy(p);bad["articleInfo"]["fields"][0]["blockIds"]=["missing"]
        self.assertTrue(r.validate_article_info(bad))
        bad=copy.deepcopy(p);bad["blocks"][0]["kind"]="methods"
        self.assertTrue(r.validate_article_info(bad))
        self.assertEqual(r.validate_article_info({"sections":[],"blocks":[]}),[])


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def extract(self,long=False):
        pdf=make(self.root,long);work=self.root/('long' if long else 'short');r.extract(pdf,work);return pdf,work


    def test_article_information_changes_review_scope_only(self):
        _,w=self.extract();p=r.read(w/'paper.json');m=r.read(w/'source-manifest.json')
        content=r.fingerprint(p);before=r.review_fingerprint(p,m)
        p['articleInfo']={'sectionIds':['source'],'fields':[]}
        self.assertEqual(content,r.fingerprint(p));self.assertNotEqual(before,r.review_fingerprint(p,m))


    def test_section_and_block_anchor_collision_is_rejected(self):
        _,w=self.extract();p=r.read(w/'paper.json');p['sections'][0]['sectionId']=p['blocks'][0]['blockId'];r.write(w/'paper.json',p)
        self.assertTrue(any('Section IDs' in e for e in r.validate(w)['content']['errors']))

    def test_variable_pages_scan_and_source_coverage(self):
        for long,count in [(False,2),(True,4)]:
            _,w=self.extract(long);p=r.read(w/'paper.json');self.assertEqual(len(p['pages']),count)
            qa=r.validate(w);self.assertEqual(qa['content']['status'],'blocked')
            self.assertFalse(qa['content']['errors'])
            if long:self.assertTrue(any('Scanned page' in s for s in qa['content']['blocked']))

    def test_resume_keeps_identity_and_rejects_other_pdf(self):
        pdf,w=self.extract();before=(w/'paper.json').read_bytes()
        self.assertEqual(r.extract(pdf,w,True)['status'],'resumed');self.assertEqual(before,(w/'paper.json').read_bytes())
        other=make(self.root,True)
        with self.assertRaises(ValueError):r.extract(other,w,True)

    def test_translation_rejects_missing_duplicate_stale_and_changed_numbers_atomically(self):
        _,w=self.extract();batchfile=Path(r.prepare(w,10000)['batches'][0]);batch=r.read(batchfile)
        response={'batchId':batch['batchId'],'translations':[{'blockId':b['blockId'],'enHash':b['enHash'],'zh':'译文 '+b['en'],'formatting':[],'issues':[]} for b in batch['blocks']]}
        before=(w/'paper.json').read_bytes()
        mutations=[lambda x:x['translations'].pop(),lambda x:x['translations'].append(x['translations'][0]),lambda x:x['translations'][0].update(enHash='0'*64),lambda x:x['translations'][2].update(zh='样本数量被改变为 99。')]
        for mutate in mutations:
            bad=copy.deepcopy(response);mutate(bad);file=w/'bad.json';r.write(file,bad)
            with self.assertRaises(ValueError):r.accept_translation(w,file)
            self.assertEqual(before,(w/'paper.json').read_bytes())

    def test_glyph_coverage_duplicate_and_missing_fail(self):
        _,w=self.extract();p=r.read(w/'paper.json');p['blocks'][0]['sourceSpans'].pop();r.write(w/'paper.json',p)
        self.assertEqual(r.validate(w)['content']['status'],'fail')

    def test_unfinished_content_cannot_build_as_complete(self):
        _,w=self.extract()
        with self.assertRaises(ValueError):r.build(w)
        result=r.build(w,True);self.assertEqual(result['status'],'draft')
        html=(w/'reader.html').read_text();self.assertIn('application/pdf;base64',html);self.assertIn('image/png;base64',html);self.assertNotIn('<script src=',html)

    def test_crop_bounds_and_duplicate_figure(self):
        _,w=self.extract()
        with self.assertRaises(ValueError):r.crop(w,1,[-1,0,100,100],'main:1')
        r.crop(w,1,[39,206,271,328],'main:1')
        with self.assertRaises(ValueError):r.crop(w,1,[39,206,271,328],'main:1')

    def test_invisible_whitespace_glyph_retains_provenance(self):
        from reportlab.pdfgen.canvas import Canvas
        pdf=self.root/'space.pdf';c=Canvas(str(pdf));c.drawString(30,40,' ');c.save()
        w=self.root/'space';r.extract(pdf,w);p=r.read(w/'paper.json')
        self.assertEqual(p['blocks'][0]['kind'],'header-footer')
        self.assertEqual(p['blocks'][0]['translationStatus'],'original-only')
        self.assertFalse(r.validate(w)['content']['errors'])


if __name__=='__main__':unittest.main()
