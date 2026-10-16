#!/usr/bin/env python3
"""Build a self-authored citation DEVELOPMENT fixture, never a cold benchmark.

The authoring specification predates canonical paper construction. Its labels,
numbered bibliography, figure geometry, and exact PDF drawing operations form
the independent expected ledger. A second pdfplumber read supplies a full-glyph
inventory directly from source.pdf. No external article, network, or prior
translation is used. The HTML is intentionally built with --draft semantics.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
import sys
from collections import defaultdict
from io import BytesIO
from pathlib import Path

import pdfplumber
from reportlab.pdfgen import canvas

WIDTH, HEIGHT = 612, 792
NOTICE = "SELF-AUTHORED DEVELOPMENT FIXTURE - NOT REAL RESEARCH"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ranges(keys):
    out = []
    for pid, index in dict.fromkeys(keys):
        if out and out[-1]["pageId"] == pid and out[-1]["glyphEnd"] == index:
            out[-1]["glyphEnd"] += 1
        else:
            out.append({"pageId": pid, "glyphStart": index, "glyphEnd": index + 1})
    return out


def utf16(text):
    return len(text.encode("utf-16-le")) // 2


def source_object(value):
    """Preserve PDF object metadata without serializing active PDF streams."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return round(value, 8)
    if isinstance(value, (list, tuple)):
        return [source_object(item) for item in value]
    if isinstance(value, dict):
        return {str(key): source_object(item) for key, item in value.items()
                if key not in {"stream", "stroking_pattern", "non_stroking_pattern"}}
    if hasattr(value, "name"):
        return str(value.name)
    if hasattr(value, "objid"):
        return {"objectId": value.objid, "type": type(value).__name__}
    return {"type": type(value).__name__}


class Source:
    def __init__(self, path):
        self.path = path
        self.c = canvas.Canvas(str(path), pagesize=(WIDTH, HEIGHT), invariant=1, pageCompression=0)
        self.c.setTitle("Self-authored citation development fixture")
        self.c.setAuthor("Micro-paper development fixture; fictitious design notes")
        self.c.setSubject(NOTICE)
        self.records, self.figures, self.page = [], [], 1

    def text(self, bid, en, zh, kind, section, y, *, size=11, x=42, width=528,
             font="Times-Roman", label=None, numbers=None, style="bracket", superscript=None,
             reference_number=None, reason=None):
        rows, row = [], ""
        for word in en.split(" "):
            proposal = (row + " " + word) if row else word
            if row and self.c.stringWidth(proposal, font, size) > width:
                rows.append(row)
                row = word
            else:
                row = proposal
        if row:
            rows.append(row)
        if superscript is not None and len(rows) != 1:
            raise ValueError("Raised fixture glyph must fit on one authored source line")
        self.c.setFillColorRGB(.07, .12, .10)
        for n, line in enumerate(rows):
            baseline = y - n * 15
            self.c.setFont(font, size)
            if superscript is None:
                self.c.drawString(x, baseline, line)
            else:
                start, end = superscript
                before, raised, after = line[:start], line[start:end], line[end:]
                self.c.drawString(x, baseline, before)
                offset = x + self.c.stringWidth(before, font, size)
                self.c.setFont(font, 7)
                self.c.drawString(offset, baseline + 4, raised)
                offset += self.c.stringWidth(raised, font, 7)
                self.c.setFont(font, size)
                self.c.drawString(offset, baseline, after)
        record = dict(blockId=bid, page=self.page, en=en, zh=zh, kind=kind,
                      section=section, rows=rows, label=label, numbers=numbers,
                      style=style, superscript=superscript,
                      referenceNumber=reference_number, reason=reason)
        self.records.append(record)
        return y - len(rows) * 15 - 13

    def banner(self):
        self.text(f"fixture-banner-{self.page}", NOTICE, "", "header-footer", None,
                  765, size=9, reason="Repeated development-only notice; source retained, no research content.")

    def finish_page(self):
        self.text(f"fixture-footer-{self.page}", f"Development fixture | source page {self.page}", "",
                  "header-footer", None, 24, size=9,
                  reason="Self-authored development page footer.")
        self.c.showPage()
        self.page += 1

    def generate(self):
        self.banner()
        y = self.text("fixture-title", "Citation navigation development fixture", "参考文献跳转开发测试样例",
                      "heading", "metadata", 724, size=18)
        y = self.text("fixture-notice", "This is a synthetic interface test. Its design notes are invented and make no scientific claims.",
                      "这是合成界面测试；其中的设计记录为自写虚构内容，不提出科学结论。", "body", "metadata", y)
        y = self.text("fixture-author", "Fixture Author (fictitious); interface development only.",
                      "样例作者（虚构）；仅用于界面开发。", "body", "metadata", y)
        cases = [
            ("single", "A single citation [1] names the first self-authored design note.", "单条引用[1]指向第一条自写设计记录。", "[1]", [1]),
            ("range", "A consecutive range [1–3] includes every self-authored design note.", "连续范围[1–3]包含全部三条自写设计记录。", "[1–3]", [1, 2, 3]),
            ("group", "A lexical group [3,1] keeps the shown target order for navigation.", "组合引用[3,1]保留显示顺序用于跳转。", "[3,1]", [3, 1]),
        ]
        for bid, en, zh, label, numbers in cases:
            y = self.text("fixture-" + bid, en, zh, "body", "reading", y,
                          label=label, numbers=numbers)
        en = "A raised citation2 points to the second self-authored design note."
        at = en.index("2")
        y = self.text("fixture-superscript", en, "上标引用2指向第二条自写设计记录。", "body", "reading", y,
                      label="2", numbers=[2], style="superscript", superscript=(at, at + 1))
        en = "The year (2026), the value 103 and Fig. 1 are negative controls."
        at = en.index("103") + 2
        y = self.text("fixture-negative", en, "年份（2026）、数值103和图1是排除对照。", "body", "reading", y,
                      superscript=(at, at + 1))
        for index in range(1, 6):
            y = self.text(f"fixture-spacing-{index}",
                          f"Reading row {index} provides ordinary selectable prose. Local search and saved notes must retain these exact words across navigation.",
                          f"阅读段落{index}提供普通可选文字。本地搜索与已保存笔记在跳转前后必须保留这些原有文字。",
                          "body", "reading", y)
            if index == 1:
                # Explicit authored previous ID, before paper.json exists. Both
                # language texts remain identical in this migration scenario.
                self.records[-1]["legacyBlockId"] = "fixture-legacy-spacing-1"
        self.finish_page()
        self.banner()
        y = self.text("fixture-methods-heading", "Interface exercises", "界面练习", "heading", "exercises", 724, size=17)
        y = self.text("fixture-parenthetical", "A parenthetical citation (2) exercises an additional explicit source label.",
                      "括号引用(2)用于练习另一种明确的来源标记。", "methods", "exercises", y,
                      label="(2)", numbers=[2], style="parenthetical")
        self.c.setStrokeColorRGB(.15, .35, .25)
        self.c.setFillColorRGB(.87, .93, .88)
        self.c.rect(80, 392, 170, 150, fill=1)
        self.c.rect(345, 392, 170, 150, fill=1)
        self.c.line(250, 467, 345, 467)
        self.text("fixture-figure-label-a", "A", "", "figure-label", None, 472, x=157, size=18,
                  reason="Original source diagram label retained in the figure crop.")
        self.text("fixture-figure-label-b", "B", "", "figure-label", None, 472, x=422, size=18,
                  reason="Original source diagram label retained in the figure crop.")
        self.figures.append(dict(figureId="main:1", sourcePageNumber=2, crop=[65, 235, 530, 415],
                                 captionBlockIds=["fixture-caption"],
                                 sourceEvidence="Authoring operations draw two boxes, connector, and A/B labels on source page 2 within the stated PDF-point bounds."))
        y = self.text("fixture-caption", "Fig. 1. This self-authored rectangle uses design guidance [2,3].",
                      "图1。这个自写矩形示例使用设计记录[2,3]。", "caption", "captions", 348,
                      label="[2,3]", numbers=[2, 3])
        for index in range(1, 5):
            y = self.text(f"fixture-exercise-{index}",
                          f"Exercise {index} preserves local interaction state while the reader moves between prose, source pages, and reference targets.",
                          f"练习{index}在正文、原页与文献条目之间切换时保留本地交互状态。",
                          "methods", "exercises", y)
        self.finish_page()
        self.banner()
        y = self.text("fixture-references-heading", "References", "参考文献", "heading", "references", 724, size=17)
        for number, subject, chinese in [(1, "Selection and exact text", "选区与原有文字"),
                                         (2, "Keyboard target navigation", "键盘目标跳转"),
                                         (3, "Local state preservation", "本地状态保留")]:
            y = self.text(f"fixture-reference-{number}",
                          f"{number}. Fixture Author. {subject}. Self-authored design note, 2026. Synthetic development material only.",
                          f"{number}. Fixture Author。{chinese}。自写设计记录，2026。仅用于合成开发测试。",
                          "reference", "references", y, reference_number=number)
        self.text("fixture-end", "End of the self-authored development fixture. No real research article or bibliography has been reproduced.",
                  "自写开发样例结束。本样例未转载真实研究文章或参考文献。", "body", "references", y)
        self.finish_page()
        self.c.save()


def independent_inventory(pdf):
    result = dict(schemaVersion=1, sourceSha256=digest(pdf.read_bytes()), independentOfPaper=True,
                  selfAuthored=True, realResearch=False,
                  provenance=dict(input="source.pdf", tool="pdfplumber", version=importlib.metadata.version("pdfplumber")),
                  pages=[])
    with pdfplumber.open(pdf) as doc:
        for number, page in enumerate(doc.pages, 1):
            glyphs = [dict(text=g["text"], font=g["fontname"], size=round(g["size"], 3),
                           bbox=[round(g[key], 3) for key in ("x0", "top", "x1", "bottom")]) for g in page.chars]
            images, drawings = [], []
            for index, item in enumerate(page.images):
                image = {**source_object(item), "regionId": f"p{number}:image:{index}"}
                if item.get("stream") is not None:
                    raw = item["stream"].get_rawdata()
                    image.update(encodedStreamSha256=digest(raw) if raw is not None else None,
                                 encodedStreamBytes=len(raw) if raw is not None else None)
                images.append(image)
            for kind, items in (("line", page.lines), ("rect", page.rects), ("curve", page.curves)):
                drawings.extend({**source_object(item), "regionId": f"p{number}:{kind}:{index}", "drawingKind": kind}
                                for index, item in enumerate(items))
            result["pages"].append(dict(pageId=f"p{number}", number=number, width=page.width, height=page.height,
                                         rotation=page.rotation, glyphCount=len(glyphs), glyphs=glyphs,
                                         images=images, drawings=drawings))
    result["pageCount"] = len(result["pages"])
    return result


def bind_authoring(records, inventory):
    """Map authored draw order directly to independent PDF glyphs, before paper."""
    cursor = defaultdict(int)
    expected_targets, expected_citations = [], []
    for record in records:
        page = inventory["pages"][record["page"] - 1]
        pid, start = f"p{record['page']}", cursor[record["page"]]
        raw = "".join(record["rows"])
        end = start + len(raw)
        glyphs = page["glyphs"][start:end]
        assert "".join(g["text"] for g in glyphs) == raw, record["blockId"]
        assert all(len(g["text"]) == 1 for g in glyphs), "Fixture font changed to multichar glyph encoding"
        box = [min(g["bbox"][0] for g in glyphs), min(g["bbox"][1] for g in glyphs),
               max(g["bbox"][2] for g in glyphs), max(g["bbox"][3] for g in glyphs)]
        record["sourceSpans"] = [dict(pageId=pid, glyphStart=start, glyphEnd=end, bbox=box)]
        cursor[record["page"]] = end
        if record["referenceNumber"]:
            prefix = str(record["referenceNumber"]) + ". "
            assert raw.startswith(prefix)
            expected_targets.append(dict(number=record["referenceNumber"],
                                         glyphRanges=[dict(pageId=pid, glyphStart=start, glyphEnd=start + len(prefix))],
                                         exactText=prefix))
        if record["label"]:
            label = record["label"]
            assert raw.count(label) == 1 and record["en"].count(label) == 1 and record["zh"].count(label) == 1
            position = raw.index(label)
            expected_citations.append(dict(numbers=record["numbers"], style=record["style"],
                                          glyphRanges=[dict(pageId=pid, glyphStart=start + position, glyphEnd=start + position + len(label))],
                                          exactText=label))
    assert all(cursor[p["number"]] == len(p["glyphs"]) for p in inventory["pages"]), "Unowned source glyphs"
    return expected_targets, expected_citations


def authored_figure_ledger(source, inventory, inventory_hash):
    """Bind known authored drawings and captions before canonical construction."""
    figures = copy.deepcopy(source.figures)
    records = {record["blockId"]: record for record in source.records}
    for figure in figures:
        # Independently render the author's PDF crop before reader.crop or
        # paper.json exists. The expected image hash never comes from a reader
        # asset or embedded HTML image.
        import pypdfium2
        document = pypdfium2.PdfDocument(str(source.path))
        page = document[figure["sourcePageNumber"] - 1]
        bitmap = page.render(scale=4)
        image = bitmap.to_pil()
        pixel_box = tuple(round(value * 4) for value in figure["crop"])
        cropped = image.crop(pixel_box)
        buffer = BytesIO()
        cropped.save(buffer, format="PNG")
        expected_bytes = buffer.getvalue()
        proof = source.path.parent / "source-figure-proofs" / (figure["figureId"].replace(":", "-") + ".png")
        proof.parent.mkdir(exist_ok=True)
        if proof.exists():
            raise ValueError("Independent figure proof already exists; do not overwrite development evidence")
        proof.write_bytes(expected_bytes)
        figure.update(assetSha256=digest(expected_bytes), scale=4, pixelBox=list(pixel_box),
                      sourceAssetProof=str(proof.relative_to(source.path.parent)))
        cropped.close(); image.close(); bitmap.close(); page.close(); document.close()
        figure["captionEvidence"], figure["captionGlyphRanges"], figure["captionBlockMappings"] = [], [], []
        for bid in figure["captionBlockIds"]:
            record = records[bid]
            figure["captionEvidence"].append(dict(blockId=bid, canonicalBlockId=bid,
                enHash=digest(record["en"].encode("utf-8")), sourceSpans=copy.deepcopy(record["sourceSpans"]),
                sourceEvidence="The original authored caption is one paragraph below the two-box diagram; its exact draw-string glyphs were independently matched before paper.json construction."))
            figure["captionGlyphRanges"].extend(dict(blockId=bid, canonicalBlockId=bid, **span)
                                                for span in record["sourceSpans"])
            figure["captionBlockMappings"].append(dict(originalBlockId=bid, canonicalBlockId=bid,
                                                       start=0, end=utf16(record["en"])))
    page_reviews = []
    for page in inventory["pages"]:
        number = page["number"]
        # Source authoring above draws exactly two rectangles and one connecting
        # line on page 2, with no images or other graphic operations anywhere.
        assert not page["images"], "Unexpected image outside the authored source specification"
        expected = ["line", "rect", "rect"] if number == 2 else []
        assert sorted(d["drawingKind"] for d in page["drawings"]) == expected
        graphics = []
        if number == 2:
            graphics.append(dict(regionIds=[d["regionId"] for d in page["drawings"]],
                decision="figure", figureIds=["main:1"],
                evidence="Source authoring explicitly draws the connecting line and two rectangles as Fig. 1; all three genuine PDF drawing objects are inventoried."))
        page_reviews.append(dict(pageId=page["pageId"], status="pass",
            evidence="Reviewed against the original self-authored draw operations and an independent read of every PDF glyph and graphic object; no real scientific material is present.",
            orderedBlockIds=[r["blockId"] for r in source.records if r["page"] == number], graphics=graphics))
    return dict(schemaVersion=1, selfAuthored=True, realResearch=False, coldBenchmark=False,
        sourceSha256=inventory["sourceSha256"], inventorySha256=inventory_hash,
        figureLedgerComplete=True, pageReviews=page_reviews, figures=figures)


def make(skill, out):
    if out.exists() and any(out.iterdir()):
        raise ValueError("Output directory must be absent or empty; development evidence is not overwritten")
    out.mkdir(parents=True, exist_ok=True)
    source = Source(out / "source.pdf")
    source.generate()
    inventory = independent_inventory(out / "source.pdf")
    expected_targets, expected_citations = bind_authoring(source.records, inventory)
    write(out / "source-inventory.json", inventory)
    inventory_hash = digest((out / "source-inventory.json").read_bytes())
    source_hash = inventory["sourceSha256"]
    write(out / "authored-source-ledger.json", dict(schemaVersion=1, selfAuthored=True, realResearch=False,
          coldBenchmark=False, sourceSha256=source_hash, inventorySha256=inventory_hash,
          provenance="Original authoring operations and intended reference semantics, bound to independent PDF glyphs before paper.json construction.",
          records=source.records, figures=source.figures))
    write(out / "figure-ledger.json", authored_figure_ledger(source, inventory, inventory_hash))
    sys.path.insert(0, str(skill / "scripts"))
    spec = importlib.util.spec_from_file_location("fixture_reader", skill / "scripts" / "reader.py")
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    import reference_citations as citations
    work = out / "work"
    reader.extract(out / "source.pdf", work)
    paper, manifest = reader.read(work / "paper.json"), reader.read(work / "source-manifest.json")
    document_id = "self-authored-reference-" + source_hash[:20]
    paper["documentId"] = manifest["documentId"] = document_id
    for actual, expected in zip(manifest["pages"], inventory["pages"]):
        assert actual["glyphs"] == expected["glyphs"], "Independent extraction differs from reader manifest"
    paper.update(metadata=dict(titleEn="Self-authored citation development fixture", titleZh="自写引用开发测试样例",
                               authors=["Fixture Author (fictitious)"]),
                 blocks=[], sections=[], formatting=[], inlineReferences=[], sourceEdits=[], issues=[],
                 reviewScopes={"fullScientificReview": {"status": "not-performed", "evidence": "Synthetic interface exercise only; no real scientific manuscript or results."}})
    sections = [("metadata", "Fixture information", "样例信息"), ("reading", "Reading examples", "阅读示例"), ("exercises", "Interface exercises", "界面练习"),
                ("captions", "Figure legends", "图注"), ("references", "References", "参考文献")]
    for order, record in enumerate(source.records):
        block = {key: record[key] for key in ("blockId", "kind", "en", "zh", "sourceSpans")}
        block.update(order=order, enHash=reader.textsha(block["en"]), zhHash=reader.textsha(block["zh"]),
                     translationStatus="original-only" if block["kind"] in reader.EXEMPT else "reviewed")
        if record["reason"]:
            block["exclusionReason"] = record["reason"]
        paper["blocks"].append(block)
        if record.get("legacyBlockId"):
            for language in ("en", "zh"):
                paper["idMap"].append(dict(oldBlockId=record["legacyBlockId"], newBlockId=record["blockId"],
                    language=language, oldStart=0, oldEnd=utf16(record[language]),
                    newStart=0, newEnd=utf16(record[language]), oldText=record[language], newText=record[language]))
        if len(record["rows"]) > 1:
            paper["sourceEdits"].append(dict(blockId=block["blockId"], kind="physical-line-rejoin",
                                             sourceText="\n".join(record["rows"]), canonicalText=record["en"],
                                             evidence="Authoring specification defines one paragraph; PDF row endings are layout only."))
        if record["superscript"]:
            start, end = record["superscript"]
            zh_start = record["zh"].index("2") if record["label"] else record["zh"].index("103") + 2
            for lang, left, right in (("en", start, end), ("zh", zh_start, zh_start + 1)):
                paper["formatting"].append(dict(blockId=block["blockId"], language=lang,
                     start=reader.u16len(block[lang][:left]), end=reader.u16len(block[lang][:right]), kind="sup",
                     sourceEvidence="Self-authored source draws this glyph at 7pt, baseline +4pt; paired Chinese position retains the same intended notation."))
    for sid, en, zh in sections:
        paper["sections"].append(dict(sectionId=sid, titleEn=en, titleZh=zh,
                                      blockIds=[r["blockId"] for r in source.records if r["section"] == sid]))
    paper["articleInfo"] = dict(sectionIds=["metadata"], fields=[
        dict(key="title", labelEn="Fixture title", labelZh="样例标题", blockIds=["fixture-title"]),
        dict(key="notice", labelEn="Development notice", labelZh="开发说明", blockIds=["fixture-notice"], collapsed=False),
        dict(key="author", labelEn="Fictitious author", labelZh="虚构作者", blockIds=["fixture-author"])])
    paper["toc"] = dict(version=1, items=[
        dict(id="toc-reading", titleEn="Reading examples", titleZh="阅读示例", role="navigation-group",
             targetId="reading", open=True, evidence="Development navigation groups the authored reading and interface exercises.",
             children=[dict(id="toc-exercises", titleEn="Interface exercises", titleZh="界面练习", role="source",
                            targetId="exercises", sourceBlockIds=["fixture-methods-heading"])]),
        dict(id="toc-references", titleEn="References", titleZh="参考文献", role="source", targetId="references",
             sourceBlockIds=["fixture-references-heading"])])
    reader.write(work / "paper.json", paper)
    reader.write(work / "source-manifest.json", manifest)
    figure = source.figures[0]
    reader.crop(work, figure["sourcePageNumber"], figure["crop"], figure["figureId"], scale=4)
    paper = reader.read(work / "paper.json")
    paper["figures"][0]["captionBlockIds"] = figure["captionBlockIds"]
    paper["figures"][0]["panelLabels"] = ["A", "B"]
    target_result = citations.build_reference_targets(paper, manifest)
    assert not target_result["unresolved"], target_result
    paper["referenceTargets"] = target_result["targets"]
    decisions = []
    for record in source.records:
        if not record["label"]:
            continue
        starts = {lang: record[lang].index(record["label"]) for lang in ("en", "zh")}
        ends = {lang: starts[lang] + len(record["label"]) for lang in ("en", "zh")}
        en_id = citations.citation_id(record["blockId"], "en", reader.u16len(record["en"][:starts["en"]]), reader.u16len(record["en"][:ends["en"]]))
        for lang in ("en", "zh"):
            decision = dict(blockId=record["blockId"], language=lang,
                            start=reader.u16len(record[lang][:starts[lang]]), end=reader.u16len(record[lang][:ends[lang]]),
                            style=record["style"], reviewNote="Original self-authored specification explicitly cites these fictitious design notes at this exact occurrence; checked against genuine PDF glyphs.")
            if lang == "zh":
                decision["sourceEnCitationId"] = en_id
            decisions.append(decision)
    built = citations.build_reference_citations(paper, manifest, decisions)
    assert not built["audit"]["errors"] and not built["unresolved"], built
    paper["referenceCitations"] = built["citations"]
    paper["referenceCitationCandidates"] = []
    reader.write(work / "paper.json", paper)
    reader.freeze(work)
    paper = reader.read(work / "paper.json")
    manifest = reader.read(work / "source-manifest.json")
    audit = citations.audit_reference_citations(paper, manifest)
    assert audit["status"] == "pass", audit
    write(out / "reference-audit.json", {**audit, "sourceSha256": source_hash, "selfAuthored": True, "realResearch": False})
    candidate_inventory = citations.source_candidate_inventory(inventory)
    write(out / "reference-candidates.json", candidate_inventory)
    expected = [("bibliography-prefix", x) for x in expected_targets] + [("inline-citation", x) for x in expected_citations]
    candidate_decisions = []
    for candidate in candidate_inventory["candidates"]:
        matches = [entry for role, entry in expected if role == candidate["role"] and entry["glyphRanges"] == candidate["glyphRanges"] and entry["exactText"] == candidate["exactText"]]
        for entry in matches:
            entry["sourceCandidateId"] = candidate["sourceCandidateId"]
        candidate_decisions.append(dict(sourceCandidateId=candidate["sourceCandidateId"],
             status="approved" if matches else "excluded",
             reason="Explicit original authoring specification identifies this bibliography prefix or citation occurrence." if matches else "Authoring specification identifies this numeric context as a year, exponent, figure label, or non-citation text; no bibliography link is intended."))
    write(out / "reference-ledger.json", dict(schemaVersion=1, sourceSha256=source_hash,
          inventorySha256=inventory_hash, referenceCandidatesSha256=digest((out / "reference-candidates.json").read_bytes()),
          referenceLedgerComplete=True, selfAuthored=True, realResearch=False, coldBenchmark=False,
          provenance="Expected EN source occurrences originate from the authored specification mapped directly to PDF glyphs before constructing canonical paper data; ZH is checked only as paired rendering.",
          reviewedPageNumbers=list(range(1, inventory["pageCount"] + 1)), candidateDecisions=candidate_decisions,
          expectedTargets=expected_targets, expectedCitations=expected_citations))
    report = reader.validate(work)
    assert not report["content"]["errors"], report["content"]
    result = reader.build(work, draft=True, filename_template="reference-dev-reader.html", generated_date="2026-10-15")
    summary = dict(schemaVersion=1, selfAuthored=True, realResearch=False, coldBenchmark=False,
                   sourceSha256=source_hash, pageCount=inventory["pageCount"], blockCount=len(paper["blocks"]),
                   targets=len(paper["referenceTargets"]), enCitations=audit["counts"]["enCitations"],
                   zhCitations=audit["counts"]["zhCitations"], sourceGlyphs=sum(p["glyphCount"] for p in inventory["pages"]),
                   citationAudit=audit, content=report["content"], build=result,
                   scope="Development regression only. Scientific review not performed; browser acceptance must run independently.")
    write(out / "fixture-summary.json", summary)
    return summary


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--skill", type=Path, default=Path(__file__).resolve().parents[1])
    cli.add_argument("--out", type=Path, required=True)
    args = cli.parse_args()
    print(json.dumps(make(args.skill.resolve(), args.out.resolve()), ensure_ascii=False, indent=2))
