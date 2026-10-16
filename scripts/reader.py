#!/usr/bin/env python3
"""Deterministic PDF preparation and reader assembly. Translation belongs to the Agent."""
import argparse
import copy
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections import Counter
from pathlib import Path

# Modules can also be imported by a host with an arbitrary current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_common import locked_work, work_lock
from reference_citations import validate_reference_citations

VERSION = "1.6.0"
ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ["body", "methods", "references", "captions", "mainFigures", "extendedData", "reportingSummary"]
KINDS = {"heading", "body", "methods", "reference", "caption", "reporting", "figure-label", "header-footer", "table", "equation"}
EXEMPT = {"figure-label", "header-footer"}


def read(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def write(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_suffix(p.suffix + ".tmp")
    temp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(p)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def textsha(s):
    return sha(s.encode("utf-8"))


def u16len(s):
    return len(s.encode("utf-16-le")) // 2


def fingerprint(p):
    return sha(json.dumps([[b["blockId"], b["en"], b.get("zh", "")] for b in sorted(p["blocks"], key=lambda b: b["order"])], ensure_ascii=False, separators=(",", ":")).encode())


def review_fingerprint(p, m):
    metadata = p.get("metadata", {})
    return textsha(json.dumps({"content": fingerprint(p), "pages": p["pages"], "blocks": [[b["blockId"], b["kind"], b["sourceSpans"], b.get("exclusionReason")] for b in p["blocks"]], "sections": p["sections"], "figures": p["figures"], "formatting": p["formatting"], "references": p["inlineReferences"], "sourceEdits": p["sourceEdits"], "articleInfo": p.get("articleInfo"), "toc": p.get("toc"), "legacyToc": p.get("readerSettings", {}).get("toc") if isinstance(p.get("readerSettings", {}), dict) else None, "journal": metadata.get("journal") if isinstance(metadata, dict) else None, "reviewScopes": p.get("reviewScopes"), "idMap": p.get("idMap", []), "paragraphMerges": p.get("paragraphMerges", []), "manifestPages": m["pages"], **{key: p[key] for key in ("referenceTargets", "referenceCitations", "referenceCitationCandidates", "sourceTranscriptionLedgerSha256") if key in p}}, sort_keys=True, ensure_ascii=False, separators=(",", ":")))


def u16slice(text, start, end):
    validate_range(text, start, end)
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def validate_id_map(p):
    errors, seen = [], set()
    blocks = {b["blockId"]: b for b in p["blocks"]}
    maps = p.get("idMap", [])
    if not isinstance(maps, list):
        return ["idMap must be an array"]
    valid = []
    for m in maps:
        try:
            if not isinstance(m, dict) or m.get("language") not in {"en", "zh"} or not isinstance(m.get("oldBlockId"), str) or not m["oldBlockId"]:
                raise ValueError("Invalid mapping identity")
            old_start, old_end, new_start, new_end = [m[k] for k in ["oldStart", "oldEnd", "newStart", "newEnd"]]
            if any(type(x) is not int for x in [old_start, old_end, new_start, new_end]) or not 0 <= old_start < old_end:
                raise ValueError("Invalid mapping range")
            t = blocks[m["newBlockId"]][m["language"]]
            if not isinstance(m.get("oldText"), str) or m["oldText"] != m.get("newText") or u16len(m["oldText"]) != old_end - old_start or old_end - old_start != new_end - new_start or u16slice(t, new_start, new_end) != m["newText"]:
                raise ValueError("Mapping must preserve exact equal-length text")
            key = json.dumps(m, sort_keys=True, ensure_ascii=False)
            if key in seen:
                raise ValueError("Duplicate mapping would make note location ambiguous")
            seen.add(key); valid.append(m)
        except (KeyError, ValueError, UnicodeError, TypeError):
            errors.append("Invalid or duplicate idMap UTF-16 range/text/target")
    for i, a in enumerate(valid):
        for b in valid[i + 1:]:
            if (a["oldBlockId"], a["language"]) == (b["oldBlockId"], b["language"]) and max(a["oldStart"], b["oldStart"]) < min(a["oldEnd"], b["oldEnd"]):
                errors.append("Overlapping idMap ranges would make one-hop note migration ambiguous")
    return errors


def merge_reviewed_paragraphs(p, request):
    """Pure, explicit source-reviewed regrouping; never infer merges from indentation."""
    ids = request.get("blockIds", [])
    evidence = request.get("sourceEvidence", "")
    joiners = request.get("joiners", {})
    if request.get("decision") != "same" or not isinstance(evidence, str) or not evidence.strip():
        raise ValueError("An explicit same-paragraph decision and original-page evidence are required")
    if not isinstance(ids, list) or len(ids) < 2 or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("At least two unique source blockIds are required")
    if set(joiners) != {"en", "zh"} or any(not isinstance(s, str) or len(s) > 2 or s.strip() for s in joiners.values()):
        raise ValueError("Supply exact EN/ZH whitespace joiners; no textual rewriting")
    out = copy.deepcopy(p)
    blocks = {b["blockId"]: b for b in out["blocks"]}
    if any(i not in blocks for i in ids):
        raise ValueError("Unknown source blockId")
    parts = [blocks[i] for i in ids]
    if parts[0]["kind"] not in {"body", "methods", "caption"} or any(b["kind"] != parts[0]["kind"] for b in parts):
        raise ValueError("Different content types or a heading cannot be merged")
    sections = [s for s in out["sections"] if any(i in s["blockIds"] for i in ids)]
    if len(sections) != 1:
        raise ValueError("Only one continuous reading section may be regrouped")
    section = sections[0]; position = section["blockIds"].index(ids[0])
    if section["blockIds"][position:position + len(ids)] != ids:
        raise ValueError("Source paragraphs must be consecutive in explicit reading order")
    if any(not b.get(lang) for b in parts for lang in ["en", "zh"]):
        raise ValueError("Both existing languages are required; this operation does not translate")
    offsets = {lang: {} for lang in ["en", "zh"]}
    first, merged = ids[0], copy.deepcopy(parts[0])
    for lang in ["en", "zh"]:
        text = ""
        for i, b in enumerate(parts):
            if i: text += joiners[lang]
            offsets[lang][b["blockId"]] = u16len(text)
            text += b[lang]
        merged[lang] = text; merged[lang + "Hash"] = textsha(text)
    merged["sourceSpans"] = [copy.deepcopy(span) for b in parts for span in b["sourceSpans"]]
    merged["translationStatus"] = "needs-review"
    merged.pop("reviewEvidence", None)
    merged.pop("bbox", None)  # A single old-page rectangle cannot describe a multi-page paragraph.
    for kind in ["formatting", "inlineReferences"]:
        for item in out[kind]:
            if item["blockId"] in ids:
                delta = offsets[item["language"]][item["blockId"]]
                item["blockId"] = first
                for target in [item] + item.get("targets", []):
                    target["start"] += delta; target["end"] += delta
                    value = u16slice(merged[item["language"]], target["start"], target["end"])
                    if "exactText" in target and target["exactText"] != value:
                        raise ValueError("Reference/target text changed during regrouping")
    mappings = out.get("idMap", [])
    for m in mappings:
        if m["newBlockId"] in ids:
            delta = offsets[m["language"]][m["newBlockId"]]
            m["newBlockId"] = first; m["newStart"] += delta; m["newEnd"] += delta
    for b in parts:
        for lang in ["en", "zh"]:
            start = offsets[lang][b["blockId"]]
            mappings.append({"oldBlockId": b["blockId"], "newBlockId": first, "language": lang, "oldStart": 0, "oldEnd": u16len(b[lang]), "newStart": start, "newEnd": start + u16len(b[lang]), "oldText": b[lang], "newText": b[lang]})
    # Drop exact or contained equivalent segments: locate() requires one verified one-hop map.
    deduplicated = []
    for m in sorted(mappings, key=lambda x: x["oldEnd"] - x["oldStart"], reverse=True):
        redundant = any((n["oldBlockId"], n["language"], n["newBlockId"]) == (m["oldBlockId"], m["language"], m["newBlockId"]) and n["newStart"] - n["oldStart"] == m["newStart"] - m["oldStart"] and n["oldStart"] <= m["oldStart"] and n["oldEnd"] >= m["oldEnd"] and u16slice(n["oldText"], m["oldStart"] - n["oldStart"], m["oldEnd"] - n["oldStart"]) == m["oldText"] for n in deduplicated)
        if not redundant: deduplicated.append(m)
    out["idMap"] = deduplicated
    out["blocks"] = [merged if b["blockId"] == first else b for b in out["blocks"] if b["blockId"] not in ids[1:]]
    section["blockIds"][position:position + len(ids)] = [first]
    for figure in out.get("figures", []):
        figure["captionBlockIds"] = list(dict.fromkeys(first if i in ids else i for i in figure["captionBlockIds"]))
    out.setdefault("paragraphMerges", []).append({"decision": "same", "oldBlockIds": copy.deepcopy(ids), "mergedBlockId": first, "joiners": copy.deepcopy(joiners), "utf16Offsets": offsets, "sourceEvidence": evidence, "oldTextHashes": {b["blockId"]: {lang: textsha(b[lang]) for lang in ["en", "zh"]} for b in parts}})
    out["contentFingerprint"] = fingerprint(out)
    errors = validate_id_map(out)
    if errors: raise ValueError("; ".join(errors))
    return out


RENDERER_RESOURCES = (
    "assets/reader/index.html", "assets/reader/style.css", "assets/reader/reader.js",
    "assets/reader/image-interactions.js", "assets/reader/article-info.js", "assets/reader/article-info.css",
    "assets/reader/column-layout.js", "assets/reader/column-layout.css", "assets/reader/reader-presentation.js",
    "assets/reader/export-name.js", "assets/reader/notes-state.js", "assets/reader/toc.js",
    "assets/reader/original-pdf.js", "scripts/package.mjs", "scripts/export-name.mjs",
    "assets/reader/selection-tools.js", "assets/reader/selection-tools.css",
    "assets/reader/reading-font.js", "assets/reader/reading-font.css",
    "assets/reader/article-search.js", "assets/reader/article-search.css",
    "assets/reader/reference-links.js", "assets/reader/reference-links.css",
)


def renderer_fingerprint():
    return sha(b"".join((ROOT / path).read_bytes() for path in RENDERER_RESOURCES))


def dependencies():
    try:
        import pdfplumber
        import pypdfium2
        from PIL import Image
    except ImportError as e:
        raise ValueError(f"Missing extraction dependency: {e}. Reuse an installed runtime or isolated official packages.") from e
    return pdfplumber, pypdfium2


def safe_asset(work, path):
    p = (work / path).resolve()
    if not p.is_relative_to(work.resolve()) or not p.is_file():
        raise ValueError(f"Missing or out-of-workspace asset: {path}")
    return p


def inspect(path):
    pdfplumber, _ = dependencies()
    with pdfplumber.open(path) as pdf:
        return {"sourceSha256": sha(Path(path).read_bytes()), "pageCount": len(pdf.pages), "pages": [{"number": i + 1, "width": p.width, "height": p.height, "rotation": p.rotation, "glyphCount": len(p.chars), "imageCount": len(p.images), "vectorCount": len(p.lines) + len(p.curves) + len(p.rects), "status": "needs-ocr-review" if not p.chars else "needs-layout-review"} for i, p in enumerate(pdf.pages)]}


def extract(path, out, resume=False):
    with work_lock(out, "extract"):
        if (Path(out) / ".translation-transaction").exists():
            raise ValueError("Unfinished translation transaction; recover before extraction")
        return _extract(path, out, resume)


def _extract(path, out, resume=False):
    pdfplumber, pdfium = dependencies()
    path, out = Path(path), Path(out)
    source_hash = sha(path.read_bytes())
    if (out / "paper.json").exists():
        if resume and read(out / "paper.json")["sourceSha256"] == source_hash:
            return {"status": "resumed", "work": str(out), "message": "Frozen source and IDs retained; no extraction overwritten."}
        raise ValueError("Existing paper work directory; use --resume for the identical PDF, or a new directory.")
    out.mkdir(parents=True, exist_ok=True)
    if path.resolve() != (out / "source.pdf").resolve():
        shutil.copy2(path, out / "source.pdf")
    paper = {"schemaVersion": 1, "documentId": "paper-" + uuid.uuid4().hex, "sourceSha256": source_hash, "rendererVersion": VERSION, "metadata": {"titleEn": path.stem, "titleZh": "", "authors": []}, "pages": [], "sections": [], "blocks": [], "figures": [], "inlineReferences": [], "formatting": [], "idMap": [], "sourceEdits": [], "issues": []}
    manifest = {"schemaVersion": 1, "documentId": paper["documentId"], "sourceSha256": source_hash, "pageCount": 0, "tools": {m: importlib.metadata.version(m) for m in ["pdfplumber", "pypdfium2", "Pillow"]}, "pages": [], "coverage": []}
    doc = pdfium.PdfDocument(str(path))
    with pdfplumber.open(path) as pdf:
        for n, page in enumerate(pdf.pages, 1):
            pid = f"p{n}"
            asset = f"pages/{pid}.png"
            (out / "pages").mkdir(exist_ok=True)
            doc[n - 1].render(scale=2).to_pil().save(out / asset)
            chars = [{"text": c["text"], "font": c["fontname"], "size": round(c["size"], 3), "bbox": [round(c[k], 3) for k in ["x0", "top", "x1", "bottom"]]} for c in page.chars]
            paper["pages"].append({"pageId": pid, "number": n, "width": page.width, "height": page.height, "rotation": page.rotation, "assetRef": asset})
            manifest["pages"].append({"pageId": pid, "number": n, "glyphs": chars, "images": [{"bbox": [i[k] for k in ["x0", "top", "x1", "bottom"]]} for i in page.images], "vectorCount": len(page.lines) + len(page.curves) + len(page.rects), "issues": ["Scan requires transcription and visual review"] if not chars else ["Reading order, regions, formatting and figure boundaries require visual review"]})
            # Spatial line candidates. Crossing the gutter stays full-width; classification is reviewed by Agent.
            buckets = {}
            for i, c in enumerate(chars):
                x0, top, x1, bottom = c["bbox"]
                col = 0 if x1 < page.width * .50 else 1 if x0 > page.width * .50 else 2
                key = (col, round(top / 3) * 3)
                buckets.setdefault(key, []).append((i, c))
            lines = []
            for (col, y), values in buckets.items():
                values.sort(key=lambda v: v[1]["bbox"][0])
                s, fs, last = "", [], None
                for index, c in values:
                    if last and c["bbox"][0] - last["bbox"][2] > max(1.5, c["size"] * .15) and not s.endswith(" "):
                        s += " "
                    start = u16len(s)
                    s += c["text"]
                    if re.search("Italic|Oblique", c["font"], re.I):
                        fs.append({"start": start, "end": u16len(s), "kind": "italic", "sourceEvidence": f"{pid} glyph {index} font {c['font']}"})
                    last = c
                # Even invisible whitespace has provenance; do not silently drop glyphs.
                lines.append((col, y, values, s, fs))
            lines.sort(key=lambda v: (v[0], v[1]))
            for col, y, values, s, fs in lines:
                indices = sorted(i for i, _ in values)
                # Exact individual glyph spans keep provenance despite PDF object ordering.
                bid = f"{pid}-g{min(indices)}"
                bbox = [min(c["bbox"][0] for _, c in values), min(c["bbox"][1] for _, c in values), max(c["bbox"][2] for _, c in values), max(c["bbox"][3] for _, c in values)]
                spans = [{"pageId": pid, "glyphStart": i, "glyphEnd": i + 1, "bbox": c["bbox"]} for i, c in values]
                block = {"blockId": bid, "order": len(paper["blocks"]), "kind": "body", "en": s, "zh": "", "enHash": textsha(s), "zhHash": textsha(""), "translationStatus": "pending", "sourceSpans": spans, "candidateColumn": col, "bbox": bbox}
                if not s.strip():
                    block.update(kind="header-footer", translationStatus="original-only", exclusionReason="Whitespace-only source glyphs have no visible text; retained for exact provenance.")
                paper["blocks"].append(block)
                paper["formatting"].extend({"blockId": bid, "language": "en", **f} for f in fs)
            if not chars:
                paper["issues"].append({"pageId": pid, "message": "Scanned page: transcription and complete region coverage required"})
    doc.close()
    manifest["pageCount"] = len(paper["pages"])
    paper["sections"] = [{"sectionId": "source", "titleEn": "Source text", "titleZh": "原文", "blockIds": [b["blockId"] for b in paper["blocks"]]}]
    paper["contentFingerprint"] = fingerprint(paper)
    write(out / "paper.json", paper)
    write(out / "source-manifest.json", manifest)
    write(out / "glossary.json", {})
    freeze(out)
    return {"status": "needs-review", "pages": len(paper["pages"]), "candidateBlocks": len(paper["blocks"]), "work": str(out)}


LABEL = re.compile(r"(?:(Extended\s+Data|Supplementary|扩展数据|补充)\s*)?(?:Fig(?:ure)?s?\.?|图)\s*", re.I)
ITEM = re.compile(r"(\d+)([a-z](?:\s*[-–—]\s*[a-z])?)?(?:\s*[-–—]\s*(\d+)([a-z])?)?", re.I)
PANEL = re.compile(r"([a-z](?:\s*[-–—]\s*[a-z])?)(?![a-z0-9])", re.I)


def parse_references(s):
    refs = []
    for label in LABEL.finditer(s):
        scope = "extended" if label[1] and (label[1].lower().startswith("extended") or label[1] == "扩展数据") else "supplement" if label[1] else "main"
        pos, ids, panels, targets, end, item_ids = label.end(), [], [], [], label.end(), []
        for _ in range(30):
            match = ITEM.match(s, pos)
            if match:
                first, last = int(match[1]), int(match[3] or match[1])
                if last < first or last - first > 30:
                    break
                item_ids = [f"{scope}:{v}" for v in range(first, last + 1)]
                ids.extend(item_ids)
                groups = [match[2], match[4]]
            else:
                match = PANEL.match(s, pos) if item_ids else None
                if not match:
                    break
                groups = [match[1]]
            targets.append({"start": u16len(s[:match.start()]), "end": u16len(s[:match.end()]), "exactText": match[0], "figureIds": item_ids})
            for group in groups:
                if group:
                    letters = re.findall("[a-z]", group.lower())
                    panels.extend([chr(v) for v in range(ord(letters[0]), ord(letters[-1]) + 1)] if len(letters) > 1 else letters)
            end = match.end()
            join = re.match(r"\s*(?:[,，]\s*(?:and\s+)?|and\s+|以及\s*|及\s*|和\s*|、\s*)", s[end:], re.I)
            if not join:
                break
            pos = end + join.end()
        if ids:
            refs.append({"start": u16len(s[:label.start()]), "end": u16len(s[:end]), "exactText": s[label.start():end], "figureIds": list(dict.fromkeys(ids)), "panelLabels": list(dict.fromkeys(panels)), "targets": targets})
    return refs


@locked_work
def freeze(work, keep_references=False):
    p = read(work / "paper.json")
    p["blocks"].sort(key=lambda b: b["order"])
    for b in p["blocks"]:
        h = textsha(b["en"])
        if b.get("enHash") != h:
            b["translationStatus"] = "pending"
            b["zh"] = ""
        b["enHash"], b["zhHash"] = h, textsha(b.get("zh", ""))
    if not keep_references:
        p["inlineReferences"] = [{"blockId": b["blockId"], "language": lang, **ref} for b in p["blocks"] if b["kind"] not in EXEMPT for lang in ["en", "zh"] for ref in parse_references(b.get(lang, ""))]
    p["contentFingerprint"] = fingerprint(p)
    write(work / "paper.json", p)
    m = read(work / "source-manifest.json")
    m["coverage"] = [{"pageId": page["pageId"], "regions": [{"blockId": b["blockId"], "kind": b["kind"], "spans": [s for s in b["sourceSpans"] if s["pageId"] == page["pageId"]]} for b in p["blocks"] if any(s["pageId"] == page["pageId"] for s in b["sourceSpans"])]} for page in p["pages"]]
    write(work / "source-manifest.json", m)
    return {"status": "frozen", "contentFingerprint": p["contentFingerprint"]}


@locked_work
def crop(work, page_number, box, figure_id, scale=4):
    _, pdfium = dependencies()
    p = read(work / "paper.json")
    if any(f["figureId"] == figure_id for f in p["figures"]):
        raise ValueError("Figure ID already registered; edit its record explicitly instead of overwriting.")
    if not re.fullmatch(r"(main|extended|supplement):\d+", figure_id):
        raise ValueError("Figure ID requires main:N, extended:N or supplement:N")
    page = p["pages"][page_number - 1]
    x0, top, x1, bottom = box
    if not (0 <= x0 < x1 <= page["width"] and 0 <= top < bottom <= page["height"] and scale >= 2):
        raise ValueError("Crop outside source page or scale below 2")
    doc = pdfium.PdfDocument(str(work / "source.pdf"))
    image = doc[page_number - 1].render(scale=scale).to_pil()
    asset = f"figures/{figure_id.replace(':','-')}.png"
    (work / "figures").mkdir(exist_ok=True)
    image.crop(tuple(round(v * scale) for v in box)).save(work / asset)
    doc.close()
    scope, number = figure_id.split(":")
    p["figures"].append({"figureId": figure_id, "scope": scope, "number": int(number), "sourcePageId": page["pageId"], "crop": box, "assetRef": asset, "captionBlockIds": [], "panelLabels": [], "representation": {"kind": "source-page-crop", "scale": scale, "originalPdf": "source.pdf"}})
    write(work / "paper.json", p)
    return {"status": "needs-visual-review", "figureId": figure_id, "assetRef": asset}


@locked_work
def prepare(work, max_chars):
    if any((work / name).exists() for name in ("structure-approval.json", "translation-jobs", "translation-receipts.json")):
        raise ValueError("This article uses immutable translation jobs; use translation_pipeline.py instead of the legacy batch writer")
    p = read(work / "paper.json")
    blocks = p["blocks"]
    groups, current, count = [], [], 0
    for i, b in enumerate(blocks):
        if b["kind"] in EXEMPT or b.get("translationStatus") == "reviewed":
            continue
        if current and count + len(b["en"]) > max_chars:
            groups.append(current)
            current, count = [], 0
        current.append({"blockId": b["blockId"], "enHash": b["enHash"], "en": b["en"], "section": next((s["titleEn"] for s in p["sections"] if b["blockId"] in s["blockIds"]), ""), "contextBefore": blocks[i - 1]["en"] if i else "", "contextAfter": blocks[i + 1]["en"] if i + 1 < len(blocks) else "", "formatting": [f for f in p["formatting"] if f["blockId"] == b["blockId"] and f["language"] == "en"], "relatedCaptions": [c for c in blocks if any(b["blockId"] == r["blockId"] and f["figureId"] in r["figureIds"] and c["blockId"] in f["captionBlockIds"] for f in p["figures"] for r in p["inlineReferences"])]})
        count += len(b["en"])
    if current:
        groups.append(current)
    batch_dir = work / "translation"
    batch_dir.mkdir(exist_ok=True)
    files = []
    for group in groups:
        bid = textsha(json.dumps([[b["blockId"], b["enHash"]] for b in group]))[:20]
        file = batch_dir / f"batch-{bid}.json"
        write(file, {"schemaVersion": 1, "batchId": bid, "sourceSha256": p["sourceSha256"], "glossary": read(work / "glossary.json"), "blocks": group})
        files.append(str(file))
    return {"status": "await-agent-translation", "batches": files, "blocks": sum(len(g) for g in groups)}


def invariants(s):
    # Digits, scientific symbols and all mixed alphanumeric gene/unit tokens.
    return Counter(re.findall(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b[A-Za-z]+\d+[A-Za-z0-9-]*\b|[α-ωΑ-Ω]|\b(?:mg|kg|μm|nm|mM|μM|ml|mL|Hz|kDa|DNA|RNA)\b", s))


@locked_work
def accept_translation(work, response_path):
    if any((work / name).exists() for name in ("structure-approval.json", "translation-jobs", "translation-receipts.json")):
        raise ValueError("This article uses immutable translation jobs; use translation_pipeline.py instead of the legacy batch writer")
    p, response = read(work / "paper.json"), read(response_path)
    batch_file = work / "translation" / f"batch-{response['batchId']}.json"
    batch = read(batch_file)
    if batch["sourceSha256"] != p["sourceSha256"]:
        raise ValueError("Translation batch source mismatch")
    expected = {b["blockId"]: b for b in batch["blocks"]}
    items = response["translations"]
    ids = [t["blockId"] for t in items]
    if len(ids) != len(set(ids)) or set(ids) != set(expected):
        raise ValueError("Translation missing, duplicate or unexpected block IDs")
    blocks = {b["blockId"]: b for b in p["blocks"]}
    for t in items:
        b = blocks[t["blockId"]]
        if t["enHash"] != expected[b["blockId"]]["enHash"] or t["enHash"] != textsha(b["en"]):
            raise ValueError(f"Stale source hash: {b['blockId']}")
        if not isinstance(t.get("zh"), str) or not t["zh"].strip() or t["zh"] == b["en"]:
            raise ValueError(f"Missing translation or English copied as Chinese: {b['blockId']}")
        en_tokens, zh_tokens = invariants(b["en"]), invariants(t["zh"])
        diff = {v for v in en_tokens.keys() | zh_tokens.keys() if en_tokens[v] != zh_tokens[v]}
        decisions = t.get("invariantDecisions", {})
        if any(not isinstance(decisions.get(v), str) or not decisions[v].strip() for v in diff):
            raise ValueError(f"Check changed invariant tokens for {b['blockId']}: {sorted(diff)}; explain each in invariantDecisions")
        signature = lambda s: Counter((fid, tuple(ref["panelLabels"])) for ref in parse_references(s) for fid in ref["figureIds"])
        if signature(b["en"]) != signature(t["zh"]):
            raise ValueError(f"Explicit figure scope, number or panel changed in translation: {b['blockId']}")
        for f in t.get("formatting", []):
            validate_range(t["zh"], f["start"], f["end"])
            if f["kind"] not in {"italic", "sup", "sub"} or not f.get("sourceEvidence"):
                raise ValueError("Unsupported or unevidenced Chinese formatting")
    for t in items:
        b = blocks[t["blockId"]]
        b.update(zh=t["zh"], zhHash=textsha(t["zh"]), translationStatus="needs-review" if t.get("issues") else "translated", translationIssues=t.get("issues", []), invariantDecisions=t.get("invariantDecisions", {}))
        p["formatting"] = [f for f in p["formatting"] if not (f["blockId"] == b["blockId"] and f["language"] == "zh")]
        p["formatting"].extend({"blockId": b["blockId"], "language": "zh", **f} for f in t.get("formatting", []))
    p["contentFingerprint"] = fingerprint(p)
    write(work / "paper.json", p)
    freeze(work)
    return {"status": "merged-await-source-review", "blocks": len(items)}


def validate_range(s, start, end):
    raw = s.encode("utf-16-le")
    if not isinstance(start, int) or not isinstance(end, int) or not (0 <= start < end <= len(raw) // 2):
        raise ValueError("Invalid UTF-16 range")
    for a, b in [(0, start * 2), (start * 2, end * 2), (end * 2, len(raw))]:
        raw[a:b].decode("utf-16-le")


@locked_work
def review_template(work):
    p = read(work / "paper.json")
    result = {"schemaVersion": 1, "sourceSha256": p["sourceSha256"], "contentFingerprint": p["contentFingerprint"], "reviewFingerprint": review_fingerprint(p, read(work / "source-manifest.json")), "pages": [{"pageId": x["pageId"], "status": "blocked", "evidence": ""} for x in p["pages"]], "blocks": [{"blockId": b["blockId"], "status": "blocked", "evidence": ""} for b in p["blocks"] if b["kind"] not in EXEMPT], "figures": [{"figureId": f["figureId"], "status": "blocked", "evidence": ""} for f in p["figures"]], "components": {c: {"state": "unknown", "evidence": ""} for c in COMPONENTS}}
    file = work / "review-template.json"
    write(file, result)
    return {"status": "await-real-review", "template": str(file)}


@locked_work
def accept_review(work, review_path):
    p, review = read(work / "paper.json"), read(review_path)
    if (review["sourceSha256"], review["contentFingerprint"]) != (p["sourceSha256"], p["contentFingerprint"]):
        raise ValueError("Review is stale")
    if review.get("reviewFingerprint") != review_fingerprint(p, read(work / "source-manifest.json")):
        raise ValueError("Review scope, figures or formatting changed; refresh review-template and verify changed parts")
    for key, idkey, expected in [("pages", "pageId", p["pages"]), ("blocks", "blockId", [b for b in p["blocks"] if b["kind"] not in EXEMPT]), ("figures", "figureId", p["figures"])]:
        items = review[key]
        if len({i[idkey] for i in items}) != len(items) or {i[idkey] for i in items} != {i[idkey] for i in expected}:
            raise ValueError(f"Incomplete or duplicate {key} review")
        for i in items:
            if i.get("status") not in {"pass", "fail", "blocked"} or not i.get("evidence", "").strip():
                raise ValueError(f"Unevidenced {key} review")
    if set(review["components"]) != set(COMPONENTS):
        raise ValueError("All source components must be reviewed")
    for c in review["components"].values():
        if c["state"] not in {"present", "absent"} or not c.get("evidence", "").strip():
            raise ValueError("Unresolved source component")
    for b in p["blocks"]:
        if b["kind"] not in EXEMPT and next(x for x in review["blocks"] if x["blockId"] == b["blockId"])["status"] == "pass" and b.get("zh") and not b.get("translationIssues"):
            b["translationStatus"] = "reviewed"
    write(work / "paper.json", p)
    write(work / "review.json", review)
    return validate(work)


def validate_article_info(p):
    config = p.get("articleInfo")
    if config is None:
        return []
    errors = []
    if not isinstance(config, dict):
        return ["articleInfo must be an object"]
    section_ids = config.get("sectionIds", [])
    section_map = {s["sectionId"]: s for s in p["sections"]}
    if not isinstance(section_ids, list) or not section_ids or any(not isinstance(x, str) or x not in section_map for x in section_ids) or len(section_ids) != len(set(section_ids)):
        return ["articleInfo requires unique existing metadata sectionIds"]
    members = {bid for sid in section_ids for bid in section_map[sid]["blockIds"]}
    blocks = {b["blockId"]: b for b in p["blocks"]}
    fields = config.get("fields", [])
    if not isinstance(fields, list):
        return ["articleInfo fields must be an array"]
    assigned, keys = set(), set()
    for field in fields:
        if not isinstance(field, dict):
            errors.append("Invalid articleInfo field")
            continue
        key = field.get("key")
        if not isinstance(key, str) or not key.strip() or key in keys:
            errors.append("articleInfo field keys must be unique nonempty strings")
        else:
            keys.add(key)
        if any(not isinstance(field.get(label), str) or not field[label].strip() for label in ["labelEn", "labelZh"]):
            errors.append("articleInfo fields require bilingual labels")
        ids = field.get("blockIds", [])
        if not isinstance(ids, list) or not ids:
            errors.append("articleInfo field requires source blockIds")
            continue
        for bid in ids:
            if not isinstance(bid, str) or bid not in members or bid not in blocks or bid in assigned:
                errors.append("Invalid or duplicated articleInfo source block reference")
                continue
            assigned.add(bid)
            if blocks[bid]["kind"] not in {"body", "heading"}:
                errors.append("Scientific methods/references/captions cannot be compact metadata fields")
        if "collapsed" in field and not isinstance(field["collapsed"], bool):
            errors.append("articleInfo collapsed must be boolean")
    return errors


TOC_EXCLUDED_KINDS = {"caption", "figure-label", "header-footer"}


def validate_toc(p):
    """Check navigation metadata without inventing headings or modifying source blocks."""
    settings = p.get("readerSettings", {})
    if "toc" in p:
        config = p["toc"]
    elif isinstance(settings, dict) and "toc" in settings:
        config = settings["toc"]
    else:
        return []
    if not isinstance(config, dict) or type(config.get("version")) is not int or config["version"] != 1 or not isinstance(config.get("items"), list):
        return ["toc requires version 1 and an items array"]
    errors, seen = [], set()
    if set(config) - {"version", "items"}:
        errors.append("Unknown toc configuration fields")
    blocks = {b["blockId"]: b for b in p["blocks"]}
    sections = {s["sectionId"]: s for s in p["sections"]}

    def nonempty(value):
        return isinstance(value, str) and bool(value.strip())

    def valid_target(target):
        if not nonempty(target):
            return False
        if target in blocks:
            return blocks[target]["kind"] not in TOC_EXCLUDED_KINDS
        section = sections.get(target)
        return section is not None and any(bid in blocks and blocks[bid]["kind"] not in TOC_EXCLUDED_KINDS for bid in section["blockIds"])

    def node(item, depth, ancestors):
        if not isinstance(item, dict) or depth > 16 or id(item) in ancestors:
            errors.append("Invalid toc node or hierarchy deeper than 16")
            return
        if set(item) - {"id", "titleEn", "titleZh", "role", "targetId", "children", "open", "evidence", "sourceBlockIds"}:
            errors.append("Unknown toc node fields")
        item_id = item.get("id")
        if not nonempty(item_id) or item_id in seen:
            errors.append("toc node IDs must be unique nonempty strings")
        else:
            seen.add(item_id)
        if any(not nonempty(item.get(label)) for label in ["titleEn", "titleZh"]):
            errors.append("toc nodes require bilingual labels")
        role = item.get("role")
        if not isinstance(role, str) or role not in {"source", "navigation-group"}:
            errors.append("toc role must be source or navigation-group")
        children = item.get("children", [])
        if not isinstance(children, list):
            errors.append("toc children must be an array")
            children = []
        if "targetId" in item:
            if not valid_target(item["targetId"]):
                errors.append("toc target must be an existing non-caption source section or block")
        elif role == "source" or not children:
            errors.append("toc source nodes require a target; targetless navigation groups require children")
        if "open" in item and type(item["open"]) is not bool:
            errors.append("toc open must be boolean")
        if "evidence" in item and not nonempty(item["evidence"]):
            errors.append("toc evidence must be nonempty text")
        if "sourceBlockIds" in item:
            source_ids = item["sourceBlockIds"]
            if not isinstance(source_ids, list) or not source_ids or any(not nonempty(bid) or bid not in blocks or blocks[bid]["kind"] in TOC_EXCLUDED_KINDS for bid in source_ids):
                errors.append("toc sourceBlockIds must identify existing non-caption source blocks")
            elif len(set(source_ids)) != len(source_ids):
                errors.append("toc sourceBlockIds must be unique within a node")
        chain = ancestors | {id(item)}
        for child in children:
            node(child, depth + 1, chain)

    for item in config["items"]:
        node(item, 0, set())
    return errors


def validate_reader_settings(p):
    """Retain legacy scale metadata; schema 3 defaults to complete-image contain fit."""
    settings = p.get("readerSettings", {})
    if not isinstance(settings, dict):
        return ["readerSettings must be an object"]
    errors = []
    if "figureScaleSchema" in settings and (type(settings["figureScaleSchema"]) is not int or settings["figureScaleSchema"] not in {1, 2, 3}):
        errors.append("figureScaleSchema must be 1 (legacy), 2 (source pixels), or 3 (contain default)")
    if "readingFontSize" in settings and (type(settings["readingFontSize"]) is not int or not 14 <= settings["readingFontSize"] <= 26):
        errors.append("readingFontSize must be an integer from 14 to 26")
    if "figureInitialScale" in settings:
        scale = settings["figureInitialScale"]
        if type(scale) not in {int, float} or not 0.5 <= scale <= 8:
            errors.append("figureInitialScale must be a number from 0.5 to 8")
    return errors


REVIEW_SCOPE_STATUSES = {"pass", "fail", "blocked", "pending", "not-performed", "unknown"}


def has_review_evidence(value):
    """A scope's evidence is descriptive text or a nonempty list of such records."""
    return isinstance(value, str) and bool(value.strip()) or isinstance(value, list) and bool(value) and all(isinstance(item, str) and bool(item.strip()) for item in value)


def validate_review_scopes(p):
    scopes = p.get("reviewScopes", {})
    if not isinstance(scopes, dict):
        return ["reviewScopes must be an object"]
    errors = []
    for key, scope in scopes.items():
        if not isinstance(key, str) or not key.strip() or not isinstance(scope, dict) or not isinstance(scope.get("status"), str) or scope["status"] not in REVIEW_SCOPE_STATUSES:
            errors.append("Invalid review scope record")
            continue
        if scope["status"] == "pass" and not has_review_evidence(scope.get("evidence")):
            errors.append("A passed review scope requires evidence")
        if "evidence" in scope and not has_review_evidence(scope["evidence"]):
            errors.append("Review scope evidence must be nonempty text or text records")
        if any(label in scope and not isinstance(scope[label], str) for label in ["label", "labelEn", "labelZh"]):
            errors.append("Review scope labels must be text")
    return errors


def structured_issues(issues):
    """Retain JSON diagnostics for downloads; UI summaries never render these values."""
    if not isinstance(issues, list):
        return [{"code": "invalid-issues", "detail": copy.deepcopy(issues)}]
    return [copy.deepcopy(item) if isinstance(item, (str, dict)) else {"code": "unrecognized-issue", "detail": copy.deepcopy(item)} for item in issues]


def overall_review_status(content, browser, scopes):
    """Machine/browser success is insufficient to claim a complete scientific review."""
    content = content if isinstance(content, dict) else {}
    browser = browser if isinstance(browser, dict) else {}
    scopes = scopes if isinstance(scopes, dict) else {}
    records = [record if isinstance(record, dict) else {} for record in scopes.values()]
    if content.get("status") == "fail" or browser.get("status") == "fail" or any(record.get("status") == "fail" for record in records):
        return "fail"
    scientific = scopes.get("fullScientificReview", {})
    if content.get("status") == "pass" and browser.get("status") == "pass" and isinstance(scientific, dict) and scientific.get("status") == "pass" and has_review_evidence(scientific.get("evidence")) and all(record.get("status") == "pass" and has_review_evidence(record.get("evidence")) for record in records):
        return "pass"
    return "partial"


@locked_work
def validate(work):
    p, m = read(work / "paper.json"), read(work / "source-manifest.json")
    errors, blocked = validate_reference_citations(p, m) + validate_article_info(p) + validate_id_map(p) + validate_review_scopes(p) + validate_toc(p) + validate_reader_settings(p), []
    ledger_hash = p.get("sourceTranscriptionLedgerSha256")
    if ledger_hash is not None:
        ledger_file = work / "source-transcription-ledger.json"
        if not ledger_file.is_file() or sha(ledger_file.read_bytes()) != ledger_hash:
            errors.append("Independent transcription ledger identity mismatch")
    metadata = p.get("metadata", {})
    if not isinstance(metadata, dict):
        errors.append("metadata must be an object")
    elif "journal" in metadata and not isinstance(metadata["journal"], str):
        errors.append("metadata.journal must be text")
    if p.get("schemaVersion") != 1 or m.get("schemaVersion") != 1:
        errors.append("Unsupported schemaVersion")
    if sha((work / "source.pdf").read_bytes()) != p["sourceSha256"] or m["sourceSha256"] != p["sourceSha256"] or m["documentId"] != p["documentId"]:
        errors.append("Source identity mismatch")
    if p["contentFingerprint"] != fingerprint(p):
        errors.append("Stale contentFingerprint; freeze first")
    ids, pages, figs = {}, {x["pageId"]: x for x in m["pages"]}, {f["figureId"]: f for f in p["figures"]}
    section_ids = [s["sectionId"] for s in p["sections"]]
    if len(section_ids) != len(set(section_ids)) or set(section_ids) & {b["blockId"] for b in p["blocks"]}:
        errors.append("Section IDs must be unique and distinct from block IDs for navigation")
    if len({b["order"] for b in p["blocks"]}) != len(p["blocks"]):
        errors.append("Duplicate block order")
    if len(figs) != len(p["figures"]):
        errors.append("Duplicate figure IDs")
    counts = {pid: [0] * len(page["glyphs"]) for pid, page in pages.items()}
    for b in p["blocks"]:
        bid = b["blockId"]
        if bid in ids:
            errors.append(f"Duplicate block ID {bid}")
        ids[bid] = b
        if b["kind"] not in KINDS or not b["sourceSpans"]:
            errors.append(f"Invalid kind or missing provenance {bid}")
        if b["enHash"] != textsha(b["en"]) or b["zhHash"] != textsha(b.get("zh", "")):
            errors.append(f"Hash mismatch {bid}")
        if b["kind"] in EXEMPT:
            if not b.get("exclusionReason"):
                blocked.append(f"Unexplained original-only region {bid}")
        elif not b.get("zh") or b.get("translationStatus") != "reviewed":
            blocked.append(f"Unreviewed translation {bid}")
        if b.get("translationIssues"):
            blocked.append(f"Translation issues {bid}")
        for span in b["sourceSpans"]:
            pid = span["pageId"]
            if pid not in counts:
                errors.append(f"Unknown source page {pid}")
                continue
            if span.get("transcription"):
                if not span.get("sourceEvidence") or len(span.get("bbox", [])) != 4:
                    blocked.append(f"Unevidenced transcription {bid}")
            else:
                start, end = span["glyphStart"], span["glyphEnd"]
                if not (0 <= start < end <= len(counts[pid])):
                    errors.append(f"Invalid glyph range {bid}")
                else:
                    for i in range(start, end):
                        counts[pid][i] += 1
    for pid, values in counts.items():
        if any(v != 1 for v in values):
            errors.append(f"Unassigned or duplicate source glyphs {pid}: {sum(v != 1 for v in values)}")
        if not values and not any(s["pageId"] == pid and s.get("transcription") for b in p["blocks"] for s in b["sourceSpans"]):
            blocked.append(f"Scanned page has no transcription {pid}")
    for f in p["formatting"] + p["inlineReferences"]:
        try:
            b = ids[f["blockId"]]
            s = b[f["language"]]
            validate_range(s, f["start"], f["end"])
            if "exactText" in f:
                exact = s.encode("utf-16-le")[f["start"] * 2:f["end"] * 2].decode("utf-16-le")
                if exact != f["exactText"]:
                    errors.append("Reference text mismatch")
                if any(fid not in figs for fid in f["figureIds"]):
                    blocked.append(f"Unknown explicit figure reference {f['figureIds']}")
                for target in f.get("targets", []):
                    if not f["start"] <= target["start"] < target["end"] <= f["end"] or u16slice(s, target["start"], target["end"]) != target["exactText"] or any(fid not in f["figureIds"] for fid in target["figureIds"]):
                        errors.append("Invalid individual figure target range/text/scope")
            elif f["kind"] not in {"italic", "sup", "sub"} or not f.get("sourceEvidence"):
                errors.append("Invalid formatting evidence")
        except (KeyError, ValueError, UnicodeError):
            errors.append("Invalid text range/block/language")
    for f in p["figures"]:
        if not f["captionBlockIds"] or any(bid not in ids or ids[bid]["kind"] != "caption" for bid in f["captionBlockIds"]):
            blocked.append(f"Missing/invalid caption {f['figureId']}")
        try:
            safe_asset(work, f["assetRef"])
        except ValueError as e:
            errors.append(str(e))
    for page in p["pages"]:
        try:
            safe_asset(work, page["assetRef"])
        except ValueError as e:
            errors.append(str(e))
    membership = [bid for s in p["sections"] for bid in s["blockIds"]]
    visible = {bid for bid, b in ids.items() if b["kind"] not in EXEMPT}
    if not visible.issubset(set(membership)) or len(membership) != len(set(membership)) or any(bid not in ids for bid in membership):
        errors.append("Sections must contain each visible block exactly once")
    if p.get("issues"):
        blocked.extend(structured_issues(p["issues"]))
    review_path = work / "review.json"
    if not review_path.exists():
        blocked.append("Source/translation visual review not run")
    else:
        review = read(review_path)
        if (review.get("sourceSha256"), review.get("contentFingerprint")) != (p["sourceSha256"], p["contentFingerprint"]):
            blocked.append("Review is stale")
        if review.get("reviewFingerprint") != review_fingerprint(p, m):
            blocked.append("Source review scope, figures or formatting changed")
        for key in ["pages", "blocks", "figures"]:
            if any(i["status"] != "pass" for i in review.get(key, [])):
                blocked.append(f"Incomplete {key} review")
    status = "fail" if errors else "blocked" if blocked else "pass"
    previous = read(work / "qa-report.json") if (work / "qa-report.json").exists() else {}
    report = {"schemaVersion": 1, "sourceSha256": p["sourceSha256"], "contentFingerprint": p["contentFingerprint"], "reviewFingerprint": review_fingerprint(p, m), "rendererFingerprint": renderer_fingerprint(), "reviewScopes": copy.deepcopy(p.get("reviewScopes", {})), "content": {"status": status, "errors": errors, "blocked": blocked}, "browser": previous.get("browser", {"status": "blocked", "checks": [], "reason": "Real browser acceptance not run"})}
    # A content revision invalidates browser evidence too.
    if any(previous.get(k) != report[k] for k in ["contentFingerprint", "reviewFingerprint", "rendererFingerprint"]):
        report["browser"] = {"status": "blocked", "checks": [], "reason": "Current content has not been tested in a real browser"}
    elif report["browser"].get("status") == "pass":
        checks = report["browser"].get("checks", [])
        checks = checks if isinstance(checks, list) else []
        passed = {c.get("name") for c in checks if isinstance(c, dict) and c.get("status") == "pass" and c.get("evidence")}
        missing = sorted(REQUIRED_BROWSER - passed)
        if missing:
            report["browser"] = {**report["browser"], "status": "blocked", "missing": missing, "reason": "Current browser acceptance gates lack actual passing evidence"}
    report["overall"] = {"status": overall_review_status(report["content"], report["browser"], report["reviewScopes"])}
    write(work / "qa-report.json", report)
    return report


REQUIRED_BROWSER = {
    "clean-reading-ui-and-qa-boundary", "continuous-offline-original-pdf",
    "five-color-floating-highlights-and-portable-notes", "legacy-v1-note-idmap-migration",
    "hierarchical-bilingual-toc", "metadata-two-column-source-preservation", "all-figures-contain-complete-responsive",
    "contain-zoom-pan-reset", "canonical-bilingual-source-integrity",
    "canonical-headings-and-green-legends", "navigation-and-mobile",
    "draggable-three-columns", "follow-pin-modal-and-export-names",
    "source-button-native-pdf-page-jumps",
    "storage-failure", "json-markdown-download-upload", "conflict-migration",
    "reading-font-size-controls-and-persistence", "local-bilingual-search-and-note-anchors",
    "mobile-touch-selection-and-toolbar",
    "source-bound-bibliography-citation-targets",
    "bibliography-citation-keyboard-mobile-search-notes",
}

@locked_work
def record_browser(work, path):
    validate(work)
    qa, evidence = read(work / "qa-report.json"), read(path)
    checks = evidence["checks"]
    if len({c["name"] for c in checks}) != len(checks) or any(c["status"] not in {"pass", "fail", "blocked"} or not c.get("evidence") for c in checks):
        raise ValueError("Invalid or unevidenced browser checks")
    missing = sorted(REQUIRED_BROWSER - {c["name"] for c in checks})
    qa["browser"] = {"status": "fail" if any(c["status"] == "fail" for c in checks) else "blocked" if missing or any(c["status"] == "blocked" for c in checks) else "pass", "checks": checks, "missing": missing}
    qa["overall"] = {"status": overall_review_status(qa["content"], qa["browser"], qa.get("reviewScopes", {}))}
    write(work / "qa-report.json", qa)
    return qa


@locked_work
def build(work, draft=False, filename_template=None, generated_date=None, preview=False):
    qa = read(work / "qa-report.json") if preview and (work / "qa-report.json").exists() else {"browser": {"status": "blocked"}} if preview else validate(work)
    if not preview and qa["content"]["status"] != "pass" and not draft:
        raise ValueError("Content gate is not pass. Resolve source and translation checks or use --draft for review.")
    node = shutil.which("node")
    if not node:
        raise ValueError("Node.js 18+ required by the single offline packager")
    command = [node, str(ROOT / "scripts" / "package.mjs"), str(work)]
    if filename_template is not None:
        command.extend(["--filename-template", filename_template])
    if generated_date is not None:
        command.extend(["--date", generated_date])
    if preview:
        command.append("--preview")
    owner = read(work / ".micro-paper-write.lock" / "owner.json")
    result = subprocess.run(command, check=True, capture_output=True, text=True, env={**os.environ, "MICRO_PAPER_PARENT_LOCK_TOKEN": owner["token"]})
    packaged = json.loads(result.stdout)
    return {"status": "preview" if preview else "draft" if qa["content"]["status"] != "pass" else "built", "reader": packaged.get("output", str(work / "reader.html")), "filename": packaged.get("filename", "reader.html"), "browser": qa["browser"]["status"]}


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10+ required")
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    x = commands.add_parser("inspect"); x.add_argument("pdf", type=Path)
    x = commands.add_parser("extract"); x.add_argument("pdf", type=Path); x.add_argument("--out", type=Path, required=True); x.add_argument("--resume", action="store_true")
    for name in ["freeze", "crop", "prepare-translation", "accept-translation", "review-template", "accept-review", "validate", "build", "record-browser"]:
        x = commands.add_parser(name); x.add_argument("work", type=Path)
        if name == "freeze": x.add_argument("--keep-references", action="store_true")
        if name == "crop":
            x.add_argument("--page", type=int, required=True); x.add_argument("--box", type=float, nargs=4, required=True); x.add_argument("--figure", required=True); x.add_argument("--scale", type=float, default=4)
        if name == "prepare-translation": x.add_argument("--max-chars", type=int, default=6000)
        if name in ["accept-translation", "accept-review", "record-browser"]: x.add_argument("response", type=Path)
        if name == "build":
            x.add_argument("--draft", action="store_true")
            x.add_argument("--filename-template")
            x.add_argument("--date", dest="generated_date")
            x.add_argument("--preview", action="store_true")
    a = cli.parse_args()
    try:
        match a.command:
            case "inspect": result = inspect(a.pdf)
            case "extract": result = extract(a.pdf, a.out, a.resume)
            case "freeze": result = freeze(a.work, a.keep_references)
            case "crop": result = crop(a.work, a.page, a.box, a.figure, a.scale)
            case "prepare-translation": result = prepare(a.work, a.max_chars)
            case "accept-translation": result = accept_translation(a.work, a.response)
            case "review-template": result = review_template(a.work)
            case "accept-review": result = accept_review(a.work, a.response)
            case "validate": result = validate(a.work)
            case "build": result = build(a.work, a.draft, a.filename_template, a.generated_date, a.preview)
            case "record-browser": result = record_browser(a.work, a.response)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if a.command in {"validate", "accept-review"} and result["content"]["status"] != "pass":
            return 2
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as e:
        print(json.dumps({"status": "fail", "error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
