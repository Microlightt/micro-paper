"""Self-authored generic v1.2.0 fixture, including shared/unassigned captions."""
import argparse
import importlib.util
import json
import shutil
from pathlib import Path


def make(skill, out):
    source = skill / 'tests' / 'make_layout_sample.py'
    spec = importlib.util.spec_from_file_location('generic_layout_source', source)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    old_text, old_save = base.Source.text, base.Source.save
    heading_en, heading_zh = 'Extended Data - design boxes', '扩展数据：设计框图'

    def text(self, bid, en, zh, *args, **kwargs):
        if bid == 'fixture-extended-heading':
            en, zh = heading_en, heading_zh
        return old_text(self, bid, en, zh, *args, **kwargs)

    def save(self):
        self.next_page()
        y = self.text('fixture-duplicate-heading', heading_en, heading_zh,
                      'heading', 'fixture-extended', 40, 726,
                      font='Times-Bold', size=13)
        y = self.text('fixture-generic-boundary-notice',
                      'This extra source page tests document presentation boundaries only. The repeated heading is intentionally authored twice and both canonical source blocks must survive.',
                      '这个附加来源页仅测试文档呈现边界。重复标题被有意编写两次，两个规范来源文本块都必须保留。',
                      'body', 'fixture-extended', 40, y)
        y = self.text('fixture-caption-shared',
                      'Figs. 1 and 2. Shared self-authored caption for two synthetic interface sketches. This single canonical text block belongs to both figures and contains no research results.',
                      '图1和2。两张合成界面草图共用的自行编写图注。这个唯一的规范文本块同时归属两张图，不包含研究结果。',
                      'caption', 'fixture-extended', 40, y)
        self.text('fixture-caption-unassigned',
                  'Unassigned caption sentinel. This self-authored source text has no figure-number header declaring an owner. A later cross-reference mentions Fig. 2 for navigation testing only; it does not declare caption ownership. The original text must remain searchable and selectable.',
                  '无归属图注哨兵。这个自行编写的来源文本没有用图号开头声明归属。后文仅为导航测试提到图2，并不声明图注归属。原始文本必须保持可检索和可选择。',
                  'caption', 'fixture-extended', 40, y)
        old_save(self)

    base.Source.text, base.Source.save = text, save
    evidence = base.make(skill, out)
    r = base.load_reader(skill)
    p = r.read(out / 'paper.json')
    for figure in p['figures']:
        if figure['figureId'] in {'main:1', 'main:2'}:
            figure['captionBlockIds'].append('fixture-caption-shared')
    p['fixture'].update(kind='synthetic-generic-v120', expectedPageCount=5,
                        expectedCaptionCount=5, sharedCaption='fixture-caption-shared',
                        unassignedCaption='fixture-caption-unassigned',
                        unassignedLaterCrossReference='main:2',
                        repeatedHeadingIds=['fixture-extended-heading', 'fixture-duplicate-heading'])
    p['readerSettings']['exportFilenameTemplate'] = '{year}_{title}_{date}.html'
    p['reviewScopes'] = {
        'paragraphRepair': {'status': 'pass', 'evidence': 'Self-authored synthetic source: exact authored text matched to extracted glyphs; no external-paper paragraph repair is claimed.'},
        'fullScientificReview': {'status': 'not-performed', 'evidence': 'This is a self-authored UI fixture, not scientific research. No external scientific review was performed.'},
    }
    r.write(out / 'paper.json', p)
    r.freeze(out)
    frozen = r.read(out / 'paper.json')
    later_refs = [ref for ref in frozen['inlineReferences'] if ref['blockId'] == 'fixture-caption-unassigned']
    if {ref['language'] for ref in later_refs if ref['start'] > 0 and ref['figureIds'] == ['main:2']} != {'en', 'zh'}:
        raise ValueError('Expected verified bilingual later Fig. 2 cross-reference in unassigned source caption')
    review = r.read(out / 'review.json')
    m = r.read(out / 'source-manifest.json')
    review['reviewFingerprint'] = r.review_fingerprint(r.read(out / 'paper.json'), m)
    r.write(out / 'generic-review.json', review)
    qa = r.accept_review(out, out / 'generic-review.json')
    if qa['content']['status'] != 'pass':
        raise ValueError(qa['content'])
    evidence.update(pageCount=5, sharedCaption='fixture-caption-shared',
                    unassignedCaption='fixture-caption-unassigned',
                    unassignedLaterCrossReferences=later_refs,
                    repeatedHeadingIds=p['fixture']['repeatedHeadingIds'],
                    reviewScopes=p['reviewScopes'], contentValidation=qa['content'])
    r.write(out / 'generic-fixture-evidence.json', evidence)
    built = r.build(out, filename_template='reader.html', generated_date='2026-10-15')
    # A separate same-source synthetic variant tests UI redaction of arbitrary
    # diagnostics, without modifying the primary fixture during browser checks.
    variant_name = 'qa-variant' if out.name == 'work' else 'qa-variant-' + out.name.removeprefix('work-')
    variant = out.parent / variant_name
    shutil.copytree(out, variant, dirs_exist_ok=True, ignore=shutil.ignore_patterns('*.html'))
    q = r.read(variant / 'paper.json')
    q['reviewScopes']['paragraphRepair'] = {'status': 'unknown', 'label': 'RAW_LABEL_SENTINEL', 'evidence': '/synthetic/private/RAW_EVIDENCE_SENTINEL'}
    q['issues'] = [{'code': 'synthetic-ui-boundary', 'blockId': 'RAW_ID_SENTINEL', 'path': '/synthetic/private/RAW_PATH_SENTINEL', 'label': 'RAW_LABEL_SENTINEL', 'detail': {'value': 'RAW_OBJECT_SENTINEL'}}]
    r.write(variant / 'paper.json', q)
    r.freeze(variant)
    vqa = r.validate(variant)
    variant_built = r.build(variant, draft=True, filename_template='reader-qa-unknown.html', generated_date='2026-10-15')
    result = {'primary': built, 'qaVariant': variant_built, 'variantExpectedContentStatus': vqa['content']['status'], 'fixture': evidence}
    r.write(out.parent / 'build-evidence.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(make(args.skill.resolve(), args.out.resolve()), ensure_ascii=False, indent=2))
