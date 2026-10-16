# -*- coding: utf-8 -*-
"""Make a deterministic, self-authored layout fixture; no research data or results.

Example:
  python tests/make_layout_sample.py --skill . --out /tmp/layout-fixture

The output is a four-page source PDF plus a complete micro-paper work directory.
It deliberately has a long bilingual title, fictitious front matter, scrollable
prose, and three original box diagrams. It does not modify the skill or any real
paper. A final reader can be built later with the selected skill's CLI.
"""
import argparse
import collections
import importlib.util
import json
from pathlib import Path

from reportlab.pdfgen import canvas


WIDTH, HEIGHT = 612, 792
TITLE_EN = ('Design-only synthetic document for testing long bilingual article '
            'headers, responsive reading columns, and explicit figure navigation')
TITLE_ZH = '用于测试长双语文章标题、响应式阅读栏与明确图号导航的纯设计合成文档'
AUTHORS = ['Alex Layout (fictitious)', 'Mira Template (fictitious)',
           'Tao Spacing (fictitious)', 'Rowan Mock (fictitious)']
DOI = '10.0000/layout-fixture'
NOTICE_EN = 'SYNTHETIC LAYOUT TEST FIXTURE - NOT REAL RESEARCH OR RESULTS'
NOTICE_ZH = '合成布局测试样例：不是真实研究，也不包含研究结果'


class Source:
    """Keep the authored text and geometry of every PDF text operation."""
    def __init__(self, path):
        self.c = canvas.Canvas(str(path), pagesize=(WIDTH, HEIGHT),
                               invariant=1, pageCompression=0)
        self.c.setTitle(TITLE_EN)
        self.c.setAuthor('Fictitious layout-test authors; synthetic fixture only')
        self.c.setSubject(NOTICE_EN)
        self.records, self.figures, self.page = [], [], 1

    def wrap(self, text, width, font, size):
        result, row = [], ''
        for word in text.split(' '):
            proposed = word if not row else row + ' ' + word
            if row and self.c.stringWidth(proposed, font, size) > width:
                result.append(row)
                row = word
            else:
                row = proposed
        if row:
            result.append(row)
        if any(self.c.stringWidth(row, font, size) > width + .01 for row in result):
            raise ValueError('Unbreakable fixture text exceeds its source column')
        return result

    def text(self, bid, en, zh, kind, section, x, y, width=532,
             font='Times-Roman', size=11, leading=14, gap=10, reason=None):
        rows = self.wrap(en, width, font, size)
        self.c.setFont(font, size)
        self.c.setFillColorRGB(.08, .11, .15)
        for index, row in enumerate(rows):
            self.c.drawString(x, y - leading * index, row)
        self.records.append({
            'blockId': bid, 'page': self.page, 'en': en, 'zh': zh,
            'kind': kind, 'section': section, 'rows': rows, 'font': font,
            'bbox': [x - 1, HEIGHT - y - size * 1.3, x + width + 1,
                     HEIGHT - y + leading * (len(rows) - 1) + size * .45],
            'reason': reason,
        })
        return y - len(rows) * leading - gap

    def banner(self):
        self.c.setFillColorRGB(.96, .88, .70)
        self.c.rect(30, 749, 552, 28, stroke=0, fill=1)
        return self.text(f'fixture-banner-p{self.page}', NOTICE_EN, NOTICE_ZH,
                         'header-footer', None, 40, 759, size=9, leading=12,
                         reason='Repeated, explicitly synthetic test-fixture running banner; canonical first-page notice is separately translated.')

    def footer(self):
        self.text(f'fixture-footer-p{self.page}',
                  f'Layout fixture only | page {self.page} | self-authored source',
                  '', 'header-footer', None, 40, 23, size=8,
                  reason='Self-authored test-fixture page footer; not article content or research evidence.')

    def next_page(self):
        self.footer()
        self.c.showPage()
        self.page += 1
        self.banner()

    def filler(self, bid, number, section, y, alternate=False):
        if alternate:
            en = (f'Layout-test paragraph {number}. These sentences create a dense '
                  'reading surface for scrolling and midpoint navigation checks. '
                  'The words describe spacing, line wrapping, and pane placement '
                  'only. They contain no observations, participants, experiments, '
                  'measurements, or research conclusions.')
            zh = (f'布局测试段落{number}。这些句子为滚动和阅读中点导航检查构造较密集的阅读区域。'
                  '文字只描述间距、换行和面板位置，不包含观察、受试者、实验、测量或研究结论。')
        else:
            en = (f'Layout-test paragraph {number}. The prose is intentionally '
                  'ordinary and repeated so that the reader has room to scroll. '
                  'A colored rectangle is a drawing element, not an outcome. '
                  'The fixture checks document presentation; it does not model '
                  'a scientific process or report collected data.')
            zh = (f'布局测试段落{number}。这些普通且重复的文字特意为阅读器留出滚动空间。'
                  '彩色矩形是绘图元素，不代表结果。本样例检查文档呈现方式，不模拟科学过程，'
                  '也不报告采集的数据。')
        return self.text(bid, en, zh, 'body', section, 40, y)

    def diagram(self, fid, x, y, width, height, labels, color):
        """Original labeled boxes, without axes, measurements, or result marks."""
        self.c.setFillColorRGB(.98, .98, .96)
        self.c.setStrokeColorRGB(.18, .24, .30)
        self.c.setLineWidth(1.2)
        self.c.rect(x, y, width, height, stroke=1, fill=1)
        scope, number = fid.split(':')
        title = ('Extended Data Fig. ' if scope == 'extended' else 'Fig. ') + number
        prefix = 'fixture-figure-' + fid.replace(':', '-')
        exclusion = 'Original self-authored synthetic box-diagram labels remain English inside the cropped source figure; they are design labels, not results or body prose.'
        self.text(prefix + '-title', title + ' | SYNTHETIC BOX DIAGRAM - NOT RESULTS',
                  '', 'figure-label', None, x + 12, y + height - 20,
                  width=width - 24, font='Helvetica-Bold', size=9, reason=exclusion)
        self.text(prefix + '-note', 'Design elements only; no measured values.',
                  '', 'figure-label', None, x + 12, y + height - 40,
                  width=width - 24, font='Helvetica', size=9, reason=exclusion)
        count = len(labels)
        box_width = (width - 32 - (count - 1) * 12) / count
        box_height = height - 82
        for index, label in enumerate(labels):
            bx = x + 16 + index * (box_width + 12)
            by = y + 18
            self.c.setFillColorRGB(*color)
            self.c.roundRect(bx, by, box_width, box_height, 8, stroke=1, fill=1)
            self.text(prefix + f'-panel-{chr(97 + index)}',
                      chr(97 + index) + '  ' + label, '', 'figure-label', None,
                      bx + 10, by + box_height - 20, width=box_width - 20,
                      font='Helvetica', size=9, reason=exclusion)
            self.c.setStrokeColorRGB(.40, .46, .50)
            for offset in [42, 57, 72]:
                if offset < box_height - 15:
                    self.c.line(bx + 10, by + box_height - offset,
                                bx + box_width - 10, by + box_height - offset)
        self.figures.append({'figureId': fid, 'page': self.page,
                             'crop': [x - 4, HEIGHT - y - height - 4,
                                      x + width + 4, HEIGHT - y + 4],
                             'panels': [chr(97 + n) for n in range(count)]})

    def save(self):
        self.footer()
        self.c.save()


def author_pdf(path):
    s = Source(path)
    s.banner()
    y = s.text('fixture-notice', NOTICE_EN, NOTICE_ZH, 'body',
               'fixture-front-matter', 40, 731, font='Helvetica-Bold', size=10)
    y = s.text('fixture-title', TITLE_EN, TITLE_ZH, 'heading',
               'fixture-front-matter', 40, y, font='Times-Bold', size=18,
               leading=22, gap=14)
    y = s.text('fixture-authors', 'Fictitious authors: ' + '; '.join(AUTHORS),
               '虚构作者：Alex Layout；Mira Template；Tao Spacing；Rowan Mock（全部为虚构姓名）',
               'body', 'fixture-front-matter', 40, y, size=10, leading=13)
    y = s.text('fixture-affiliations',
               'Fictitious affiliations: Imaginary Page Design Lab; Example Viewport Studio. Neither is a real institution in this fixture.',
               '虚构单位：Imaginary Page Design Lab；Example Viewport Studio。本样例中二者均为虚构机构。',
               'body', 'fixture-front-matter', 40, y, size=10, leading=13)
    y = s.text('fixture-doi', DOI + ' (unregistered test string only)',
               DOI + '（未注册，仅为测试字符串）', 'body',
               'fixture-front-matter', 40, y, size=10, leading=13)
    for bid, en, zh in [
        ('received', 'Fixture received date: 12 June 2024 (synthetic)', '样例接收日期：2024年6月12日（合成数据）'),
        ('accepted', 'Fixture accepted date: 08 July 2024 (synthetic)', '样例接受日期：2024年7月08日（合成数据）'),
        ('published', 'Fixture publication date: 18 July 2024 (synthetic)', '样例发布日期：2024年7月18日（合成数据）'),
    ]:
        y = s.text('fixture-' + bid, en, zh, 'body', 'fixture-front-matter',
                   40, y, size=10, leading=13, gap=5)
    y = s.text('fixture-unassigned-front-note',
               'Layout note: this deliberately ungrouped front-matter block must remain visible. It is authored test prose, not scientific content.',
               '布局说明：这个特意未归入元数据字段的文前块必须继续显示。它是编写的测试文字，不是科学内容。',
               'body', 'fixture-front-matter', 40, y, size=10, leading=13)
    y = s.text('fixture-summary-heading', 'Summary - layout test only', '摘要：仅用于布局测试',
               'heading', 'fixture-summary', 40, y - 3, font='Times-Bold', size=13)
    y = s.text('fixture-summary',
               'This is a self-authored synthetic document for checking a bilingual reader. The title, names, dates, DOI string, and diagrams are fixture inputs. Nothing in this document represents a real study or research finding.',
               '这是一份自行编写的合成文档，用于检查双语阅读器。标题、姓名、日期、DOI字符串和框图都是测试输入。文档中的任何内容都不代表真实研究或研究发现。',
               'body', 'fixture-summary', 40, y)
    y = s.text('fixture-body-heading', 'Body - layout test prose', '正文：布局测试文字',
               'heading', 'fixture-body', 40, y - 2, font='Times-Bold', size=13)
    for i in range(1, 3):
        y = s.filler(f'fixture-body-{i:02d}', i, 'fixture-body', y, i % 2 == 0)
    if y < 50:
        raise ValueError('Front matter overflows the fixture source page')

    s.next_page()
    y = s.text('fixture-body-continuation', 'Body continued - synthetic layout checks',
               '正文续页：合成布局检查', 'heading', 'fixture-body', 40, 726,
               font='Times-Bold', size=13)
    for i in range(3, 7):
        y = s.filler(f'fixture-body-{i:02d}', i, 'fixture-body', y, i % 2 == 0)
    y = s.text('fixture-main-one-link',
               'Fig. 1a-c shows original boxes for the title area, reading column, and figure pane. These boxes are interface sketches, not observations.',
               '图1a-c展示标题区域、阅读栏和图像面板的原创框图。这些框只是界面草图，不是观察结果。',
               'body', 'fixture-body', 40, y)
    s.diagram('main:1', 40, 203, 532, 205,
              ['Title area', 'Reading column', 'Figure pane'], (.86, .93, .96))
    y = s.text('fixture-caption-main-1',
               'Fig. 1. Original synthetic interface boxes. Labels a-c identify design regions only; no values or research outcomes are encoded.',
               '图1。原创合成界面框图。标签a-c仅标识设计区域，不表示数值或研究结果。',
               'caption', 'fixture-body', 40, 183)
    s.filler('fixture-body-07', 7, 'fixture-body', y)

    s.next_page()
    y = s.text('fixture-methods-heading', 'Methods - fixture generation only',
               '方法：仅指样例生成方式', 'heading', 'fixture-methods', 40, 726,
               font='Times-Bold', size=13)
    y = s.text('fixture-methods-01',
               'The fixture generator draws text and rectangles at fixed page positions. It records each text operation, extracts the resulting PDF glyphs, and assigns every glyph to exactly one canonical block.',
               '样例生成器在固定页面位置绘制文字和矩形，记录每次文字绘制操作，提取所得PDF字形，并将每个字形唯一归入一个规范文本块。',
               'methods', 'fixture-methods', 40, y)
    y = s.text('fixture-methods-02',
               'English and Chinese fixture prose are authored together. They describe layout testing only. There is no sampling, intervention, biological experiment, statistical model, or invented result.',
               '英文和中文测试文字同时编写，仅描述布局测试，不包含抽样、干预、生物实验、统计模型或虚构的研究结果。',
               'methods', 'fixture-methods', 40, y)
    y = s.text('fixture-methods-italic',
               'This italic sentence is a typography marker for selection tests, not an emphasized scientific claim.',
               '这句斜体文字用于选择测试中的排版标记，不是被强调的科学主张。',
               'methods', 'fixture-methods', 40, y, font='Times-Italic')
    y = s.text('fixture-main-comparison-link',
               'Compare Figs. 1a-c and 2a,b for layout navigation only.',
               '仅为检查布局导航而比较图1a-c和2a,b。',
               'methods', 'fixture-methods', 40, y)
    s.diagram('main:2', 146, 223, 320, 270,
              ['Wide card', 'Narrow card'], (.97, .88, .76))
    y = s.text('fixture-caption-main-2',
               'Fig. 2. Original synthetic cards with two design labels. The rectangular areas are arbitrary drawing geometry, not data.',
               '图2。含两个设计标签的原创合成卡片。矩形区域是任意绘制的几何形状，不是数据。',
               'caption', 'fixture-methods', 40, 203)
    y = s.text('fixture-reference-heading', 'References - test-only entry', '参考条目：仅用于测试',
               'heading', 'fixture-references', 40, y - 2, font='Times-Bold', size=13)
    s.text('fixture-reference-01',
           '1. Self-authored layout fixture documentation (2024). Example URL: https://example.org/test. This entry is not a research publication.',
           '1。自行编写的布局测试样例说明（2024）。示例网址：https://example.org/test。此条目不是研究出版物。',
           'reference', 'fixture-references', 40, y)

    s.next_page()
    y = s.text('fixture-extended-heading', 'Extended Data - original design boxes only',
               '扩展数据：仅为原创设计框图', 'heading', 'fixture-extended', 40, 726,
               font='Times-Bold', size=13)
    y = s.text('fixture-short-extended-link', 'See Extended Data Fig. 1.',
               '见扩展数据图1。', 'body', 'fixture-extended', 40, y)
    for i in range(8, 11):
        y = s.filler(f'fixture-body-{i:02d}', i, 'fixture-extended', y, i % 2 == 0)
    s.diagram('extended:1', 40, 272, 532, 198,
              ['Narrow viewport', 'Short viewport'], (.90, .87, .97))
    y = s.text('fixture-caption-extended-1',
               'Extended Data Fig. 1. Synthetic viewport boxes only.',
               '扩展数据图1。仅为合成视口框图。',
               'caption', 'fixture-extended', 40, 252)
    for i in range(11, 14):
        y = s.filler(f'fixture-body-{i:02d}', i, 'fixture-extended', y, i % 2 == 0)
    if y < 42:
        raise ValueError('Extended fixture page overflows')
    s.save()
    return s


def load_reader(skill):
    file = skill / 'scripts' / 'reader.py'
    spec = importlib.util.spec_from_file_location('layout_fixture_reader', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def glyph_spans(page, indices):
    """Compact, exact, non-overlapping provenance from extracted glyph indices."""
    groups = []
    for i in sorted(indices):
        if groups and i == groups[-1][-1] + 1:
            groups[-1].append(i)
        else:
            groups.append([i])
    result = []
    for group in groups:
        boxes = [page['glyphs'][i]['bbox'] for i in group]
        result.append({'pageId': page['pageId'], 'glyphStart': group[0],
                       'glyphEnd': group[-1] + 1,
                       'bbox': [min(b[0] for b in boxes), min(b[1] for b in boxes),
                                max(b[2] for b in boxes), max(b[3] for b in boxes)]})
    return result


def make(skill, out):
    skill, out = skill.resolve(), out.resolve()
    if not (skill / 'scripts' / 'reader.py').is_file():
        raise ValueError('--skill must identify a staged micro-paper skill')
    out.mkdir(parents=True, exist_ok=True)
    source_input = out / 'layout-fixture.pdf'
    authored = author_pdf(source_input)
    r = load_reader(skill)
    r.extract(source_input, out, resume=(out / 'paper.json').exists())
    p, m = r.read(out / 'paper.json'), r.read(out / 'source-manifest.json')
    stable_id = 'synthetic-layout-' + p['sourceSha256'][:24]
    p['documentId'] = m['documentId'] = stable_id
    p['metadata'] = {'titleEn': TITLE_EN, 'titleZh': TITLE_ZH, 'authors': AUTHORS,
                     'doi': DOI, 'year': 2024, 'publicationYear': 2024,
                     'testFixture': True, 'doiStatus': 'unregistered test string'}
    p['readerSettings'] = {'figureInitialScale': 1, 'exportFilenameTemplate': 'reader.html'}
    p['fixture'] = {'kind': 'synthetic-layout-regression', 'realResearch': False,
                    'researchResults': False, 'selfAuthored': True,
                    'expectedPageCount': 4, 'expectedFigureCount': 3}
    p['blocks'], p['formatting'], p['sourceEdits'], p['idMap'], p['issues'] = [], [], [], [], []
    pages = {x['number']: x for x in m['pages']}
    assignments = {n: collections.Counter() for n in pages}
    for order, record in enumerate(authored.records):
        page = pages[record['page']]
        x0, y0, x1, y1 = record['bbox']
        indices = [i for i, g in enumerate(page['glyphs'])
                   if x0 <= (g['bbox'][0] + g['bbox'][2]) / 2 <= x1
                   and y0 <= (g['bbox'][1] + g['bbox'][3]) / 2 <= y1]
        actual = ''.join(page['glyphs'][i]['text'] for i in indices)
        expected = ''.join(record['rows'])
        if actual != expected:
            raise ValueError(f'Authored/extracted glyph mismatch: {record["blockId"]}: {actual!r} != {expected!r}')
        assignments[record['page']].update(indices)
        b = {k: record[k] for k in ['blockId', 'kind', 'en', 'zh']}
        b.update(order=order, enHash=r.textsha(b['en']), zhHash=r.textsha(b['zh']),
                 translationStatus='original-only' if b['kind'] in r.EXEMPT else 'reviewed',
                 sourceSpans=glyph_spans(page, indices))
        if record['reason']:
            b['exclusionReason'] = record['reason']
        else:
            b['reviewEvidence'] = ('Self-authored layout-test fixture: original PDF draw-string text '
                                   'was verified character-for-character against extracted glyphs; '
                                   'paired Chinese authored and checked for this known fixture text. '
                                   'This is not external research or a scientific result.')
        p['blocks'].append(b)
        before = '\n'.join(record['rows'])
        if before != b['en']:
            p['sourceEdits'].append({'blockId': b['blockId'], 'before': before,
                                    'after': b['en'], 'reason': 'Rejoin author-controlled physical PDF line breaks without rewriting text.',
                                    'sourceEvidence': f'Generated source p{record["page"]}, exact authored rows and extracted glyphs checked.'})
        if record['font'] == 'Times-Italic':
            for lang in ['en', 'zh']:
                p['formatting'].append({'blockId': b['blockId'], 'language': lang,
                                        'start': 0, 'end': r.u16len(b[lang]), 'kind': 'italic',
                                        'sourceEvidence': 'Whole self-authored typography-marker sentence uses source Times-Italic; paired Chinese is the corresponding complete sentence.'})
        if b['kind'] not in r.EXEMPT:
            en_tokens, zh_tokens = r.invariants(b['en']), r.invariants(b['zh'])
            differences = {t for t in en_tokens.keys() | zh_tokens.keys() if en_tokens[t] != zh_tokens[t]}
            if differences:
                # Intentional English month names are translated to month numbers.
                allowed = {'June': '6', 'July': '7'}
                decisions = {}
                for token in differences:
                    month = next((word for word, number in allowed.items()
                                  if token == number and word in b['en']), None)
                    if not month:
                        raise ValueError(f'Unexplained authored translation invariant {b["blockId"]}: {token}')
                    decisions[token] = f'Synthetic date month {month} is translated as numeric month {token}; the same explicitly fictitious 2024 date is retained.'
                b['invariantDecisions'] = decisions
    for n, page in pages.items():
        if set(assignments[n]) != set(range(len(page['glyphs']))) or any(v != 1 for v in assignments[n].values()):
            raise ValueError(f'Incomplete or duplicate authored source glyph coverage on p{n}')
        page['issues'] = []
    section_names = [
        ('fixture-front-matter', 'Article information - synthetic fixture', '文章信息：合成样例'),
        ('fixture-summary', 'Summary - layout test', '摘要：布局测试'),
        ('fixture-body', 'Body - layout test', '正文：布局测试'),
        ('fixture-methods', 'Methods - fixture generation', '方法：样例生成'),
        ('fixture-references', 'References - test-only entry', '参考条目：仅用于测试'),
        ('fixture-extended', 'Extended Data - design boxes', '扩展数据：设计框图')]
    # Section navigation and canonical blocks share the browser's global ID
    # namespace. Keep separate, predictable prefixes without changing PDF text.
    p['sections'] = [{'sectionId': 'section-' + sid, 'titleEn': en, 'titleZh': zh,
                       'blockIds': [a['blockId'] for a in authored.records if a['section'] == sid]}
                      for sid, en, zh in section_names]
    p['articleInfo'] = {
        'sectionIds': ['section-fixture-front-matter'],
        'fields': [
            {'key': 'fixtureNotice', 'labelEn': 'Test fixture', 'labelZh': '测试样例', 'blockIds': ['fixture-notice'], 'collapsed': False},
            {'key': 'title', 'labelEn': 'Title', 'labelZh': '标题', 'blockIds': ['fixture-title']},
            {'key': 'authors', 'labelEn': 'Fictitious authors', 'labelZh': '虚构作者', 'blockIds': ['fixture-authors']},
            {'key': 'affiliations', 'labelEn': 'Fictitious affiliations', 'labelZh': '虚构单位', 'blockIds': ['fixture-affiliations']},
            {'key': 'doi', 'labelEn': 'DOI - unregistered test string', 'labelZh': 'DOI：未注册测试字符串', 'blockIds': ['fixture-doi']},
            {'key': 'received', 'labelEn': 'Fixture received date', 'labelZh': '样例接收日期', 'blockIds': ['fixture-received']},
            {'key': 'accepted', 'labelEn': 'Fixture accepted date', 'labelZh': '样例接受日期', 'blockIds': ['fixture-accepted']},
            {'key': 'published', 'labelEn': 'Fixture publication date', 'labelZh': '样例发布日期', 'blockIds': ['fixture-published']},
        ]}
    p['figures'] = []
    r.write(out / 'paper.json', p)
    r.write(out / 'source-manifest.json', m)
    for fig in authored.figures:
        r.crop(out, fig['page'], fig['crop'], fig['figureId'], scale=4)
    p = r.read(out / 'paper.json')
    for fig in p['figures']:
        key = fig['figureId'].replace(':', '-')
        fig['captionBlockIds'] = ['fixture-caption-' + key]
        fig['panelLabels'] = next(x['panels'] for x in authored.figures if x['figureId'] == fig['figureId'])
        fig['representation']['synthetic'] = True
        fig['representation']['researchResults'] = False
    r.write(out / 'paper.json', p)
    r.freeze(out)
    r.review_template(out)
    review = r.read(out / 'review-template.json')
    for item in review['pages']:
        item.update(status='pass', evidence='Self-authored synthetic source: every PDF glyph matched to exact authored draw-string text and uniquely assigned using fixed known geometry. Generated page has no research content. Browser/visual reader acceptance is not claimed.')
    for item in review['blocks']:
        item.update(status='pass', evidence='Known self-authored English/Chinese layout prose checked during authoring; extracted source glyph string matches authored text exactly. All names/dates/DOI are explicitly fictitious test data.')
    for item in review['figures']:
        item.update(status='pass', evidence='Original synthetic box geometry and English labels are generated by this fixture; source-page crop uses exact known bounds plus four-point border margin. There are no result plots or scientific images. Browser testing is not claimed.')
    states = {'body': 'present', 'methods': 'present', 'references': 'present',
              'captions': 'present', 'mainFigures': 'present',
              'extendedData': 'present', 'reportingSummary': 'absent'}
    for name in review['components']:
        review['components'][name] = {'state': states[name], 'evidence': 'Self-authored four-page layout fixture: this component is intentionally ' + states[name] + '; it is not an external paper or a research report.'}
    r.write(out / 'fixture-review.json', review)
    qa = r.accept_review(out, out / 'fixture-review.json')
    if qa['content']['status'] != 'pass':
        raise ValueError(qa['content'])
    p = r.read(out / 'paper.json')
    if {s['sectionId'] for s in p['sections']} & {b['blockId'] for b in p['blocks']}:
        raise ValueError('Fixture sections and canonical blocks must have distinct global IDs')
    evidence = {'fixture': True, 'realResearch': False, 'researchResults': False,
                'sourceSha256': p['sourceSha256'], 'documentId': p['documentId'],
                'pageCount': len(p['pages']), 'figureCount': len(p['figures']),
                'canonicalBlocks': len(p['blocks']),
                'glyphCounts': {f'p{n}': len(page['glyphs']) for n, page in pages.items()},
                'glyphCoverage': 'all source glyphs assigned exactly once',
                'sectionBlockIdCollision': False,
                'knownFixtureChecks': ['long bilingual title', 'four fictitious authors',
                    'explicit articleInfo field/section mapping', 'unassigned front-matter block retained',
                    'year 2024', 'unregistered DOI test string',
                    'main:1, main:2, extended:1 original box diagrams',
                    'dense scrollable body', 'short single Extended body reference',
                    'short single Extended caption reference', 'italic selection marker'],
                'contentValidation': qa['content'],
                'browserValidation': {'status': 'blocked', 'reason': 'Generator does not run a browser; final-template reader will be built and tested by the caller.'},
                'generator': str(Path(__file__).resolve())}
    r.write(out / 'fixture-evidence.json', evidence)
    (out / 'README.md').write_text(
        '# Synthetic layout test fixture\n\n'
        'This self-authored document is not real research and contains no research results. '
        'Its four fictitious authors, institutional names, dates, and unregistered DOI string '
        'are test inputs. Its three original figures contain design boxes only.\n\n'
        'Generate with `python tests/make_layout_sample.py --skill SKILL --out OUT`. '
        'The generator produces a complete, content-valid four-page work directory; '
        'build the reader with the selected skill CLI after template edits are complete. '
        'Browser testing is deliberately left to the caller.\n', encoding='utf-8')
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(make(args.skill, args.out), ensure_ascii=False, indent=2))
