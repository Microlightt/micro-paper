"""Build self-authored v1.3.0 legacy-data fallback fixture; no research content.

Uses the unchanged v1.2.0 fixture authoring source, then removes optional TOC,
article-info and scale-schema mappings to exercise the new renderer's fallback.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def make(skill, out):
    skill, out = Path(skill).resolve(), Path(out).resolve()
    source = skill / 'tests' / 'make_generic_v120_sample.py'
    spec = importlib.util.spec_from_file_location('generic_v130_legacy_author', source)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    base.make(skill, out)
    source_reader = skill / 'scripts' / 'reader.py'
    rspec = importlib.util.spec_from_file_location('generic_v130_reader', source_reader)
    reader = importlib.util.module_from_spec(rspec)
    rspec.loader.exec_module(reader)
    p = reader.read(out / 'paper.json')
    p.pop('toc', None)
    p.pop('articleInfo', None)
    p.setdefault('readerSettings', {}).pop('toc', None)
    p['readerSettings'].pop('figureScaleSchema', None)
    # A non-unit legacy fit value must not become a source-pixel preference.
    p['readerSettings']['figureInitialScale'] = 1.6
    caption = 'fixture-caption-main-1'
    for section in p['sections']:
        section['blockIds'] = [bid for bid in section['blockIds'] if bid != caption]
    p['sections'].append({'sectionId': 'legacy-caption-directory',
                          'titleEn': 'Figure 1 legend', 'titleZh': '图1图注',
                          'blockIds': [caption]})
    p['fixture'].update(
        kind='synthetic-generic-v130-legacy-fallback', realResearch=False,
        absentOptionalMappings=['toc', 'articleInfo', 'readerSettings.toc', 'readerSettings.figureScaleSchema'],
        legacyFitInitialScale=1.6, expectedSourcePixelInitialScale=1,
        portableColors=['yellow', 'blue', 'green'],
        captionOnlySection='legacy-caption-directory',
        provenance='Self-authored source and bilingual blocks reused unchanged from make_generic_v120_sample.py. Optional TOC/article-info/scale mappings are removed, an old fit preference is set, and one existing caption receives a caption-only presentation section.'
    )
    reader.write(out / 'paper.json', p)
    reader.freeze(out)
    review = reader.read(out / 'review.json')
    review['reviewFingerprint'] = reader.review_fingerprint(reader.read(out / 'paper.json'), reader.read(out / 'source-manifest.json'))
    review_file = out / 'generic-v130-review.json'
    reader.write(review_file, review)
    qa = reader.accept_review(out, review_file)
    if qa['content']['status'] != 'pass':
        raise ValueError(qa['content'])
    built = reader.build(out, filename_template='reader-v130-legacy.html', generated_date='2026-10-15')
    final = reader.read(out / 'paper.json')
    result = {
        'primary': built,
        'fixture': final['fixture'],
        'counts': {'pages': len(final['pages']), 'figures': len(final['figures']),
                   'canonicalBlocks': sum(b['kind'] not in reader.EXEMPT for b in final['blocks']),
                   'captions': sum(b['kind'] == 'caption' for b in final['blocks'])},
        'paperSha256': hashlib.sha256((out / 'paper.json').read_bytes()).hexdigest(),
        'contentValidation': qa['content'],
        'scientificReview': final['reviewScopes']['fullScientificReview'],
        'browserAcceptance': 'not-run-by-generator',
    }
    reader.write(out.parent / 'build-evidence-v130.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(make(args.skill, args.out), ensure_ascii=False, indent=2))
