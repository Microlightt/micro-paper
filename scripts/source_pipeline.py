#!/usr/bin/env python3
"""PDF-derived evidence, explicit structure review and guarded source preparation.

No function makes a semantic paragraph, figure or translation decision.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
from io import BytesIO
from concurrent.futures import ProcessPoolExecutor

from pipeline_common import structure_fingerprint, work_lock

KINDS = {"heading", "body", "methods", "reference", "caption", "reporting", "figure-label", "header-footer", "table", "equation"}
EXEMPT = {"figure-label", "header-footer"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_hash(path):
    return sha(Path(path).read_bytes()) if Path(path).is_file() else None


def within(root, rel):
    path = Path(rel)
    require(not path.is_absolute() and ".." not in path.parts and (Path(root) / path).resolve().is_relative_to(Path(root).resolve()), "Unsafe source evidence path")
    return Path(root) / path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def u16(text):
    return len(text.encode("utf-16-le")) // 2


def atomic(path, data, mode=0o644):
    path = Path(path)
    require(not path.is_symlink(), f"Refuse symlink: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".source-stage-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def json_write(path, value, mode=0o644):
    atomic(path, encoded(value), mode)


def workers_count(value):
    require(type(value) is int and 1 <= value <= 8, "workers must be an integer from 1 to 8")
    return value


def primitive(value):
    """Keep source object metadata without serializing streams or object reprs."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return round(value, 8)
    if isinstance(value, (tuple, list)):
        return [primitive(x) for x in value]
    if isinstance(value, dict):
        return {str(k): primitive(v) for k, v in value.items() if k not in {"stream", "stroking_pattern", "non_stroking_pattern"}}
    if hasattr(value, "name"):
        return str(value.name)
    if hasattr(value, "objid"):
        return {"objectId": value.objid, "type": type(value).__name__}
    return {"type": type(value).__name__}


def _page_task(args):
    """Each process opens the original PDF; page numbers are never reindexed."""
    pdf_path, number, raster_dir, scale = args
    import pdfplumber
    with pdfplumber.open(pdf_path) as document:
        page = document.pages[number - 1]
        glyphs = [{"text": c["text"], "font": c["fontname"], "size": round(c["size"], 3),
                   "bbox": [round(c[k], 3) for k in ("x0", "top", "x1", "bottom")]} for c in page.chars]
        images = []
        for index, item in enumerate(page.images):
            record = primitive(item)
            record["regionId"] = f"p{number}:image:{index}"
            stream = item.get("stream")
            if stream is not None:
                raw = stream.get_rawdata()
                record["encodedStreamSha256"] = sha(raw) if raw is not None else None
                record["encodedStreamBytes"] = len(raw) if raw is not None else None
            images.append(record)
        drawings = []
        for kind, values in (("line", page.lines), ("rect", page.rects), ("curve", page.curves)):
            for index, item in enumerate(values):
                drawings.append({**primitive(item), "regionId": f"p{number}:{kind}:{index}", "drawingKind": kind})
        record = {"pageId": f"p{number}", "number": number, "width": page.width, "height": page.height,
                  "rotation": page.rotation, "glyphCount": len(glyphs), "glyphs": glyphs,
                  "glyphSha256": sha(json.dumps([[g["text"], g["font"], g["size"], g["bbox"]] for g in glyphs], ensure_ascii=False, separators=(",", ":")).encode()),
                  "nativeOrder": list(range(len(glyphs))),
                  "spatialOrder": sorted(range(len(glyphs)), key=lambda i: (glyphs[i]["bbox"][1], glyphs[i]["bbox"][0], i)),
                  "images": images, "drawings": drawings,
                  "status": "needs-layout-review" if glyphs else "blocked-no-native-characters"}
    if raster_dir is not None:
        import pypdfium2
        document = pypdfium2.PdfDocument(pdf_path)
        page = document[number - 1]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        destination = Path(raster_dir) / f"p{number}.png"
        image.save(destination)
        record["raster"] = {"path": f"raster/p{number}.png", "sha256": sha(destination.read_bytes()), "scale": scale,
                            "pixelWidth": image.width, "pixelHeight": image.height}
        image.close(); bitmap.close(); page.close(); document.close()
    return record


def native_pages(pdf_path, workers=2, raster_dir=None, scale=2):
    import pdfplumber
    workers_count(workers)
    with pdfplumber.open(pdf_path) as document:
        total = len(document.pages)
    require(total > 0, "Source PDF has no pages")
    tasks = [(str(pdf_path), number, str(raster_dir) if raster_dir is not None else None, scale) for number in range(1, total + 1)]
    if workers == 1:
        return [_page_task(task) for task in tasks]
    with ProcessPoolExecutor(max_workers=min(workers, total)) as pool:
        return list(pool.map(_page_task, tasks))


def create_inventory(pdf_path, inventory_dir, workers=2, raster_scale=None):
    pdf_path, inventory_dir = Path(pdf_path).resolve(), Path(inventory_dir).absolute()
    require(pdf_path.is_file(), "Missing source PDF")
    require(raster_scale is None or isinstance(raster_scale, (int, float)) and math.isfinite(raster_scale) and raster_scale >= 2, "Raster scale must be at least 2")
    source_hash = sha(pdf_path.read_bytes())
    with work_lock(inventory_dir.parent, operation="source-inventory"):
        require(not inventory_dir.exists(), "Inventory already exists; immutable evidence cannot be overwritten")
        staging = Path(tempfile.mkdtemp(prefix=".inventory-stage-", dir=inventory_dir.parent))
        try:
            raster_dir = staging / "raster" if raster_scale is not None else None
            if raster_dir is not None:
                raster_dir.mkdir()
            pages = native_pages(pdf_path, workers, raster_dir, raster_scale or 2)
            require(sha(pdf_path.read_bytes()) == source_hash, "Source PDF changed during inventory")
            for page in pages:
                path = f"pages/{page['pageId']}.json"
                payload = encoded(page)
                atomic(staging / path, payload, 0o444)
                page["inventoryFile"] = path
                page["inventoryFileSha256"] = sha(payload)
            inventory = {"schemaVersion": 1, "sourceSha256": source_hash, "independentOfPaper": True,
                         "provenance": {"input": "source.pdf", "tool": "pdfplumber", "version": importlib.metadata.version("pdfplumber"),
                                        "method": "Fresh original PDF native glyph/object traversal; no paper.json input"},
                         "pageCount": len(pages), "pages": pages, "figureLedgerComplete": False}
            json_write(staging / "inventory.json", inventory, 0o444)
            for image in (staging / "raster").glob("*.png") if (staging / "raster").exists() else []:
                image.chmod(0o444)
            os.replace(staging, inventory_dir)
            return {"status": "needs-source-review", "inventory": str(inventory_dir / "inventory.json"), "sourceSha256": source_hash, "pages": len(pages)}
        except Exception:
            # Keep failed staging evidence; never publish a partial inventory.
            raise


def _line_candidates(page):
    """Exact existing reader.extract line/glyph semantics, including stable IDs."""
    buckets = {}
    for index, glyph in enumerate(page["glyphs"]):
        x0, top, x1, bottom = glyph["bbox"]
        column = 0 if x1 < page["width"] * .50 else 1 if x0 > page["width"] * .50 else 2
        buckets.setdefault((column, round(top / 3) * 3), []).append((index, glyph))
    result = []
    for (column, y), values in sorted(buckets.items()):
        values.sort(key=lambda value: value[1]["bbox"][0])
        text, formats, last = "", [], None
        for index, glyph in values:
            if last and glyph["bbox"][0] - last["bbox"][2] > max(1.5, glyph["size"] * .15) and not text.endswith(" "):
                text += " "
            start = u16(text); text += glyph["text"]
            if re.search("Italic|Oblique", glyph["font"], re.I):
                formats.append({"start": start, "end": u16(text), "kind": "italic", "sourceEvidence": f"{page['pageId']} glyph {index} font {glyph['font']}"})
            last = glyph
        indices = [index for index, _ in values]
        bbox = [min(g["bbox"][0] for _, g in values), min(g["bbox"][1] for _, g in values), max(g["bbox"][2] for _, g in values), max(g["bbox"][3] for _, g in values)]
        block = {"blockId": f"{page['pageId']}-g{min(indices)}", "kind": "body", "en": text, "zh": "", "enHash": sha(text.encode()), "zhHash": sha(b""),
                 "translationStatus": "pending", "sourceSpans": [{"pageId": page["pageId"], "glyphStart": index, "glyphEnd": index + 1, "bbox": g["bbox"]} for index, g in values],
                 "candidateColumn": column, "bbox": bbox}
        if not text.strip():
            block.update(kind="header-footer", translationStatus="original-only", exclusionReason="Whitespace-only source glyphs have no visible text; retained for exact provenance.")
        result.append((block, formats))
    return result


def extract_source(pdf_path, work, workers=2, scale=2):
    import reader
    import uuid
    pdf_path, work = Path(pdf_path).resolve(), Path(work).absolute()
    with work_lock(work, operation="extract-source"):
        require(not (work / "paper.json").exists(), "New source extraction refuses an existing paper.json")
        source_bytes = pdf_path.read_bytes()
        require(not (work / "source.pdf").exists() or (work / "source.pdf").read_bytes() == source_bytes, "Different source.pdf already exists")
        atomic(work / "source.pdf", source_bytes)
        create_inventory(work / "source.pdf", work / "source-inventory", workers, scale)
        inventory = read(work / "source-inventory/inventory.json")
        paper = {"schemaVersion": 1, "documentId": "paper-" + uuid.uuid4().hex, "sourceSha256": inventory["sourceSha256"], "rendererVersion": reader.VERSION,
                 "metadata": {"titleEn": pdf_path.stem, "titleZh": "", "authors": []}, "pages": [], "sections": [], "blocks": [], "figures": [], "inlineReferences": [], "formatting": [], "idMap": [], "sourceEdits": [], "issues": []}
        manifest = {"schemaVersion": 1, "documentId": paper["documentId"], "sourceSha256": paper["sourceSha256"], "pageCount": inventory["pageCount"],
                    "tools": {name: importlib.metadata.version(name) for name in ("pdfplumber", "pypdfium2", "Pillow")}, "pages": [], "coverage": []}
        for page in inventory["pages"]:
            asset = f"pages/{page['pageId']}.png"
            atomic(work / asset, (work / "source-inventory" / page["raster"]["path"]).read_bytes())
            paper["pages"].append({key: page[key] for key in ("pageId", "number", "width", "height", "rotation") } | {"assetRef": asset})
            manifest["pages"].append({"pageId": page["pageId"], "number": page["number"], "glyphs": page["glyphs"],
                                      "images": [{"bbox": [image[k] for k in ("x0", "top", "x1", "bottom")]} for image in page["images"]],
                                      "vectorCount": len(page["drawings"]), "issues": ["Scan requires transcription and visual review"] if not page["glyphs"] else ["Reading order, regions, formatting and figure boundaries require visual review"]})
            for block, formats in _line_candidates(page):
                block["order"] = len(paper["blocks"]); paper["blocks"].append(block)
                paper["formatting"].extend({"blockId": block["blockId"], "language": "en", **value} for value in formats)
            if not page["glyphs"]:
                paper["issues"].append({"pageId": page["pageId"], "message": "Scanned page: transcription and complete region coverage required"})
        paper["sections"] = [{"sectionId": "source", "titleEn": "Source text", "titleZh": "原文", "blockIds": [block["blockId"] for block in paper["blocks"]]}]
        paper["contentFingerprint"] = reader.fingerprint(paper)
        json_write(work / "paper.json", paper); json_write(work / "source-manifest.json", manifest); json_write(work / "glossary.json", {})
        reader.freeze(work)
        return {"status": "needs-structure-review", "work": str(work), "pages": len(paper["pages"]), "candidateBlocks": len(paper["blocks"]), "inventory": str(work / "source-inventory/inventory.json")}


def validate_transcription_ledger(paper, inventory, ledger):
    """Pure visual-source proof validation; callers bind raw ledger/inventory bytes.

    Legacy spans are accepted only when page+bbox and exact text locate one
    independent region without ambiguity. Native glyph records are never made up.
    """
    require(isinstance(ledger, dict) and ledger.get("schemaVersion") == 1 and ledger.get("independentOfPaper") is True, "Independent transcription ledger is required")
    require(ledger.get("sourceSha256") == paper.get("sourceSha256") == inventory.get("sourceSha256"), "Transcription source PDF identity differs")
    require(re.fullmatch(r"[0-9a-f]{64}", ledger.get("inventorySha256", "")), "Transcription inventory hash is required")
    require(ledger.get("provenance", {}).get("input") == "source.pdf" and ledger.get("provenance", {}).get("method") == "manual-page-raster-review", "Transcription must be independently reviewed from actual source page rasters")
    pages = {p["pageId"]: p for p in inventory["pages"]}; records = ledger.get("pages", [])
    require(records and len({p["pageId"] for p in records}) == len(records), "Duplicate or missing transcription page review")
    regions, page_regions = {}, {}
    def glyph_indices(ranges, page):
        result = []
        for item in ranges:
            start, end = item.get("glyphStart"), item.get("glyphEnd")
            require(type(start) is int and type(end) is int and 0 <= start < end <= len(page["glyphs"]), "Invalid visual-source native glyph range")
            result.extend(range(start, end))
        require(len(result) == len(set(result)), "Duplicate visual-source native glyph range")
        return result
    for record in records:
        pid = record["pageId"]; require(pid in pages, "Unknown transcription source page")
        page = pages[pid]; review = record.get("review", {}); entries = record.get("regions", [])
        require(isinstance(record.get("rasterSha256"), str) and re.fullmatch(r"[0-9a-f]{64}", record["rasterSha256"]) and page.get("raster", {}).get("sha256") == record["rasterSha256"], "Transcription page raster identity differs")
        require(review.get("status") == "reviewed" and _nonempty(review.get("reviewer")) and _nonempty(review.get("evidence")), "Complete manual page review evidence is required")
        require(review.get("coverageBbox") == [0, 0, page["width"], page["height"]], "Transcription review must explicitly cover the complete original page")
        require(entries and review.get("regionIds") == [r.get("regionId") for r in entries], "Every visual-source region needs explicit complete page coverage review")
        require(sorted(glyph_indices(review.get("nativeGlyphRanges", []), page)) == list(range(len(page["glyphs"]))), "Page review must account for every native glyph without duplication")
        page_regions[pid] = []
        assigned_native = set()
        for region in entries:
            rid = region.get("regionId"); box = region.get("bbox"); en = region.get("en")
            require(_nonempty(rid) and rid not in regions, "Duplicate or missing transcription region ID")
            require(isinstance(box, list) and len(box) == 4 and all(type(n) in {int, float} and math.isfinite(n) for n in box) and 0 <= box[0] < box[2] <= page["width"] and 0 <= box[1] < box[3] <= page["height"], "Invalid transcription source bbox")
            require(_nonempty(en) and region.get("enHash") == sha(en.encode()) and _nonempty(region.get("sourceEvidence")), "Transcription text/hash or visual evidence is incomplete")
            native = glyph_indices(region.get("nativeGlyphRanges", []), page)
            require(not assigned_native.intersection(native), "Native glyph assigned to multiple visual regions")
            assigned_native.update(native)
            for index in native:
                glyph_box = page["glyphs"][index]["bbox"]
                require(box[0] <= glyph_box[0] + .01 and box[1] <= glyph_box[1] + .01 and box[2] >= glyph_box[2] - .01 and box[3] >= glyph_box[3] - .01, "Visual region does not contain its original native glyph")
            regions[rid] = {**region, "pageId": pid, "nativeIndices": set(native)}; page_regions[pid].append(rid)
    used, mappings, visual_native = set(), [], []
    for block in paper["blocks"]:
        mapped, native_spans = [], []
        for span_index, span in enumerate(block["sourceSpans"]):
            if not span.get("transcription"):
                native_spans.append(span); continue
            matches = [r for r in regions.values() if r["pageId"] == span.get("pageId") and r["bbox"] == span.get("bbox") and ("regionId" not in span or r["regionId"] == span["regionId"])]
            require(len(matches) == 1, "Transcription span must identify one independent page region exactly")
            region = matches[0]; rid = region["regionId"]
            require(rid not in used and span.get("sourceEvidence") == region["sourceEvidence"], "Duplicate transcription region or changed source evidence")
            require("glyphStart" not in span and "glyphEnd" not in span, "Transcription cannot invent native glyph ranges")
            start, end = span.get("textStart"), span.get("textEnd")
            if start is None and end is None:
                first = block["en"].find(region["en"])
                require(first >= 0 and block["en"].find(region["en"], first + 1) < 0, "Legacy transcription text mapping is missing or ambiguous")
                start, end = u16(block["en"][:first]), u16(block["en"][:first + len(region["en"])])
            require(type(start) is int and type(end) is int and 0 <= start < end <= u16(block["en"]), "Invalid transcription UTF-16 mapping")
            try:
                text = block["en"].encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")
            except UnicodeDecodeError as error:
                raise ValueError("Transcription mapping cuts UTF-16 surrogate pair") from error
            require(text == region["en"] and all(end <= old["textStart"] or start >= old["textEnd"] for old in mapped), "Transcription canonical text differs or overlaps another region")
            value = {"blockId": block["blockId"], "spanIndex": span_index, "regionId": rid, "pageId": region["pageId"], "textStart": start, "textEnd": end, "en": text}
            used.add(rid); mapped.append(value); mappings.append(value)
        for value in mapped:
            region = regions[value["regionId"]]; observed = []
            for span in native_spans:
                if span.get("pageId") != region["pageId"]:
                    continue
                for index in range(span.get("glyphStart", 0), span.get("glyphEnd", 0)):
                    if index in region["nativeIndices"]:
                        observed.append(index); visual_native.append({"blockId": block["blockId"], "pageId": region["pageId"], "glyphIndex": index})
            require(len(observed) == len(set(observed)) and set(observed) == region["nativeIndices"], "Visual region native glyphs must remain exactly once in the same canonical block")
        if mapped:
            by_index = {v["spanIndex"]: v for v in mapped}
            visual_keys = {(v["pageId"], v["glyphIndex"]) for v in visual_native if v["blockId"] == block["blockId"]}
            raw = ""
            for index, span in enumerate(block["sourceSpans"]):
                if span.get("transcription"):
                    raw += by_index[index]["en"]
                else:
                    raw += "".join(pages[span["pageId"]]["glyphs"][i]["text"] for i in range(span["glyphStart"], span["glyphEnd"]) if (span["pageId"], i) not in visual_keys)
            plain = lambda text: re.sub(r"\s+", "", text)
            require(plain(raw) == plain(block["en"]), "Canonical transcription contains text without independent visual/native source proof; canonical-only sourceEdits cannot replace independent visual review")
    require(used == set(regions), "Independent transcription region coverage is incomplete")
    return {"status": "pass", "regionCount": len(regions), "pageIds": list(page_regions), "visualNativeGlyphs": visual_native, "transcriptionRegions": mappings}


def audit_source(work, paper=None, workers=2):
    """Audit canonical provenance against a fresh traversal of actual source.pdf."""
    work = Path(work); paper = read(work / "paper.json") if paper is None else paper
    inventory_file = work / "source-inventory/inventory.json"
    inventory = read(inventory_file); source_hash = sha((work / "source.pdf").read_bytes())
    errors, blocked = [], []
    transcription = {"pageIds": [], "visualNativeGlyphs": [], "transcriptionRegions": []}
    ledger_path = work / "source-transcription-ledger.json"
    has_transcription = any(s.get("transcription") for b in paper.get("blocks", []) for s in b.get("sourceSpans", []))
    if has_transcription or ledger_path.exists() or paper.get("sourceTranscriptionLedgerSha256"):
        if not ledger_path.is_file():
            blocked.append("Independent source-transcription-ledger.json is required")
        else:
            try:
                ledger = read(ledger_path)
                require(ledger.get("inventorySha256") == file_hash(inventory_file), "Transcription inventory file identity differs")
                require(not paper.get("sourceTranscriptionLedgerSha256") or paper["sourceTranscriptionLedgerSha256"] == file_hash(ledger_path), "Canonical transcription ledger identity differs")
                transcription = validate_transcription_ledger(paper, inventory, ledger)
            except (ValueError, KeyError, TypeError, IndexError) as error:
                errors.append("Invalid independent transcription: " + str(error))
    visual_native = {(v["blockId"], v["pageId"], v["glyphIndex"]) for v in transcription["visualNativeGlyphs"]}
    visual_spans = {(v["blockId"], v["spanIndex"]): v for v in transcription["transcriptionRegions"]}
    if source_hash != inventory.get("sourceSha256") or source_hash != paper.get("sourceSha256"):
        errors.append("Actual PDF SHA-256 differs from canonical/inventory source")
    pages = native_pages(work / "source.pdf", workers)
    if transcription["pageIds"]:
        # Re-render the actual PDF, rather than trusting a mutable raster/hash pair.
        with tempfile.TemporaryDirectory(prefix="micro-paper-transcription-audit-") as scratch:
            for pid in transcription["pageIds"]:
                stored_page = next(p for p in inventory["pages"] if p["pageId"] == pid)
                raster = stored_page["raster"]
                actual_raster = _page_task((str(work / "source.pdf"), stored_page["number"], scratch, raster["scale"]))["raster"]
                if actual_raster != raster:
                    errors.append("Transcription raster differs from freshly rendered actual PDF: " + pid)
    manifest = read(work / "source-manifest.json")
    if manifest.get("sourceSha256") != source_hash or manifest.get("documentId") != paper.get("documentId"):
        errors.append("Source manifest identity differs from actual source/canonical document")
    manifest_pages = manifest.get("pages", [])
    if manifest.get("pageCount") != len(pages) or [p.get("pageId") for p in manifest_pages] != [p["pageId"] for p in pages]:
        errors.append("Source manifest page coverage/order differs from actual PDF")
    if inventory.get("pageCount") != len(pages) or any([p.get("pageId") for p in value] != [p["pageId"] for p in pages] for value in (inventory.get("pages", []), paper.get("pages", []))):
        errors.append("Source page coverage mismatch")
    indexed = {p["pageId"]: p for p in pages}
    for actual in pages:
        manifest_page = next((p for p in manifest_pages if p.get("pageId") == actual["pageId"]), None)
        if manifest_page is None or manifest_page.get("number") != actual["number"] or manifest_page.get("glyphs") != actual["glyphs"]:
            errors.append("Source manifest native glyph evidence differs from actual PDF: " + actual["pageId"])
        stored = next((p for p in inventory.get("pages", []) if p.get("pageId") == actual["pageId"]), None)
        canonical = next((p for p in paper.get("pages", []) if p.get("pageId") == actual["pageId"]), None)
        if stored is None or any(stored.get(k) != actual[k] for k in actual):
            errors.append("Independent inventory differs from actual PDF: " + actual["pageId"])
        else:
            path = within(work / "source-inventory", stored["inventoryFile"])
            if not path.is_file() or sha(path.read_bytes()) != stored["inventoryFileSha256"]:
                errors.append("Immutable page inventory changed: " + actual["pageId"])
            if stored.get("raster"):
                raster = stored["raster"]
                if file_hash(within(work / "source-inventory", raster["path"])) != raster["sha256"]:
                    errors.append("Immutable source raster changed: " + actual["pageId"])
                if canonical is not None and file_hash(within(work, canonical.get("assetRef", ""))) != raster["sha256"]:
                    errors.append("Canonical page raster differs from source inventory: " + actual["pageId"])
        if canonical is None or any(canonical.get(k) != actual[k] for k in ("number", "width", "height", "rotation")):
            errors.append("Canonical page geometry differs from PDF: " + actual["pageId"])
        if not actual["glyphs"] and actual["pageId"] not in transcription["pageIds"]:
            blocked.append("No native characters; independent transcription/region review required: " + actual["pageId"])
    counts = {p["pageId"]: [0] * len(p["glyphs"]) for p in pages}
    for block in paper.get("blocks", []):
        observed = []
        if block.get("kind") in EXEMPT and not block.get("exclusionReason", "").strip():
            errors.append("Excluded glyphs lack source reason: " + block.get("blockId", "?"))
        for span_index, span in enumerate(block.get("sourceSpans", [])):
            try:
                if span.get("transcription"):
                    require((block["blockId"], span_index) in visual_spans, "Transcription span lacks independent proof")
                    observed.append(visual_spans[(block["blockId"], span_index)]["en"])
                    continue
                page = indexed[span["pageId"]]; start, end = span["glyphStart"], span["glyphEnd"]
                require(type(start) is int and type(end) is int and 0 <= start < end <= len(page["glyphs"]), "Invalid source glyph range")
                box = span["bbox"]; require(len(box) == 4, "Missing source bounding box")
                selected = page["glyphs"][start:end]
                union = [min(g["bbox"][0] for g in selected), min(g["bbox"][1] for g in selected), max(g["bbox"][2] for g in selected), max(g["bbox"][3] for g in selected)]
                require(all(abs(box[i] - union[i]) <= .01 for i in range(4)), "Source span bbox differs from exact glyph union")
                for index in range(start, end):
                    glyph = page["glyphs"][index]; counts[page["pageId"]][index] += 1
                    if (block["blockId"], page["pageId"], index) not in visual_native:
                        observed.append(glyph["text"])
            except (KeyError, ValueError, TypeError, IndexError):
                errors.append("Invalid actual-source provenance: " + block.get("blockId", "?"))
        plain = lambda text: re.sub(r"\s+", "", text)
        if plain("".join(observed)) != plain(block.get("en", "")):
            edits = [e for e in paper.get("sourceEdits", []) if e.get("blockId") == block.get("blockId")]
            matching = any(plain(e.get("before", "")) == plain("".join(observed)) and e.get("after") == block.get("en") and e.get("sourceEvidence") for e in edits)
            if not matching:
                errors.append("Canonical English differs from PDF glyph sequence without exact source edit: " + block.get("blockId", "?"))
    for pid, values in counts.items():
        if any(value != 1 for value in values):
            errors.append(f"Actual source glyph coverage is not exactly once: {pid} ({sum(v != 1 for v in values)})")
    if sha((work / "source.pdf").read_bytes()) != source_hash:
        errors.append("Source PDF changed during independent audit")
    return {"schemaVersion": 1, "status": "fail" if errors else "blocked" if blocked else "pass", "independentOfPaper": True,
            "sourceSha256": source_hash, "inventorySha256": sha(inventory_file.read_bytes()), "pageCount": len(pages),
            "glyphCount": sum(len(p["glyphs"]) for p in pages), "errors": errors, "blocked": blocked,
            "transcription": {"pageIds": transcription["pageIds"], "regionCount": len(transcription["transcriptionRegions"]), "ledgerSha256": file_hash(ledger_path)},
            "method": "Fresh source.pdf traversal; geometry/native glyphs/source objects and canonical sourceSpans independently compared"}


def _commit(work, changes, expected):
    """Single-writer batch with durable recovery material and hash guards."""
    work = Path(work)
    for rel, digest in expected.items():
        require(file_hash(work / rel) == digest, "Concurrent source change: " + rel)
    transaction = Path(tempfile.mkdtemp(prefix="source-", dir=_mkdir(work / "source-transactions")))
    originals, applied = {}, []
    for rel, data in changes.items():
        path = work / rel
        require(not path.is_symlink() and not Path(rel).is_absolute() and ".." not in Path(rel).parts, "Unsafe mutation path")
        originals[rel] = path.read_bytes() if path.exists() else None
        atomic(transaction / "after" / rel, data)
        if originals[rel] is not None:
            atomic(transaction / "before" / rel, originals[rel])
    journal = {"status": "prepared", "expected": expected, "changes": {rel: sha(data) for rel, data in changes.items()}, "originals": {rel: sha(data) if data is not None else None for rel, data in originals.items()}}
    json_write(transaction / "journal.json", journal)
    marker = work / ".source-transaction"
    require(not marker.exists(), "Unresolved source transaction; verify recovery material before further writes")
    json_write(marker, {"journal": str(transaction / "journal.json"), "expected": expected, "status": "prepared"})
    try:
        for rel, digest in expected.items():
            require(file_hash(work / rel) == digest, "Concurrent source change before commit: " + rel)
        for rel, data in changes.items():
            path = work / rel
            require((not path.exists() and originals[rel] is None) or (path.is_file() and path.read_bytes() == originals[rel]), "Concurrent output change: " + rel)
            atomic(path, data); applied.append(rel)
        journal["status"] = "committed"; json_write(transaction / "journal.json", journal)
        require(all(sha((work / rel).read_bytes()) == sha(data) for rel, data in changes.items()), "Commit verification failed")
        marker.unlink()
    except Exception:
        conflicts = []
        for rel in reversed(applied):
            path = work / rel
            if not path.is_file() or sha(path.read_bytes()) != sha(changes[rel]):
                conflicts.append(rel); continue
            if originals[rel] is None:
                path.unlink()
            else:
                atomic(path, originals[rel])
        journal.update(status="recovery-required" if conflicts else "rolled-back", conflicts=conflicts)
        json_write(transaction / "journal.json", journal)
        if not conflicts:
            require(all((not (work / rel).exists()) if data is None else (work / rel).read_bytes() == data for rel, data in originals.items()), "Rollback verification failed; source transaction remains blocked")
            marker.unlink(missing_ok=True)
        raise
    return str(transaction / "journal.json")


def _mkdir(path):
    path.mkdir(parents=True, exist_ok=True)
    return path


def _page_ids(block):
    return list(dict.fromkeys(span["pageId"] for span in block["sourceSpans"]))


def _boundary(left, right):
    before, after = _page_ids(left), _page_ids(right)
    aspects = ["adjacent-block"]
    if before[-1] != after[0]:
        aspects.append("cross-page")
        if int(after[0][1:]) - int(before[-1][1:]) > 1:
            aspects.append("figure-interruption")
    elif left.get("candidateColumn") != right.get("candidateColumn"):
        aspects.append("cross-column")
    return {"boundaryId": "boundary-" + sha(encoded([left["blockId"], right["blockId"]]))[:20], "leftBlockId": left["blockId"],
            "rightBlockId": right["blockId"], "leftPages": before, "rightPages": after, "requiredAspects": aspects}


def _internal_boundaries(paper):
    pages = {p["pageId"]: p for p in paper["pages"]}; result = []
    for block in paper["blocks"]:
        spans = block["sourceSpans"]
        for index, (left, right) in enumerate(zip(spans, spans[1:])):
            aspects = []
            if left["pageId"] != right["pageId"]:
                aspects = ["within-block", "cross-page"]
                if int(right["pageId"][1:]) - int(left["pageId"][1:]) > 1:
                    aspects.append("figure-interruption")
            else:
                width = pages[left["pageId"]]["width"]
                column = lambda s: 0 if s["bbox"][2] < width * .5 else 1 if s["bbox"][0] > width * .5 else 2
                if column(left) != column(right) and right["bbox"][1] + 3 < left["bbox"][1]:
                    aspects = ["within-block", "cross-column"]
            if aspects:
                result.append({"boundaryId": "internal-" + sha(encoded([block["blockId"], index, left, right]))[:20],
                               "blockId": block["blockId"], "leftSpanIndex": index, "rightSpanIndex": index + 1, "requiredAspects": aspects})
    return result


def structure_packets(work, block_order=None):
    work = Path(work)
    with work_lock(work, operation="structure-review-packets"):
        paper_bytes = (work / "paper.json").read_bytes(); paper = json.loads(paper_bytes)
        inventory_file = work / "source-inventory/inventory.json"; inventory = read(inventory_file)
        blocks = {b["blockId"]: b for b in paper["blocks"]}
        require(len(blocks) == len(paper["blocks"]), "Duplicate canonical block ID")
        order = list(block_order) if block_order is not None else [b["blockId"] for b in sorted(paper["blocks"], key=lambda b: b["order"])]
        require(len(order) == len(set(order)) and set(order) == set(blocks), "Explicit order must contain every canonical block exactly once")
        boundaries = [_boundary(blocks[a], blocks[b]) for a, b in zip(order, order[1:])]
        pages = [{"pageId": page["pageId"], "orderedBlockIds": [bid for bid in order if page["pageId"] in _page_ids(blocks[bid])],
                  "graphicRegionIds": [x["regionId"] for x in page["images"] + page["drawings"]], "status": "blocked", "evidence": ""} for page in inventory["pages"]]
        packet = {"schemaVersion": 1, "sourceSha256": paper["sourceSha256"], "paperSha256": sha(paper_bytes), "inventorySha256": sha(inventory_file.read_bytes()),
                  "sourceTranscriptionLedgerSha256": file_hash(work / "source-transcription-ledger.json"),
                  "orderedBlockIds": order, "pages": pages, "boundaries": boundaries, "internalBoundaries": _internal_boundaries(paper),
                  "blocks": [{"blockId": bid, "en": blocks[bid]["en"], "enHash": blocks[bid]["enHash"], "kind": blocks[bid]["kind"], "sourceSpans": blocks[bid]["sourceSpans"]} for bid in order]}
        payload = encoded(packet); digest = sha(payload)
        destination = work / "structure" / f"packet-{digest}.json"
        if destination.exists():
            require(destination.read_bytes() == payload, "Immutable structure packet changed")
        else:
            atomic(destination, payload, 0o444)
        response = {"schemaVersion": 1, "packetSha256": digest, "sourceSha256": packet["sourceSha256"], "paperSha256": packet["paperSha256"],
                    "pages": [{**page, "graphics": []} for page in pages],
                    "boundaries": [{**boundary, "decision": "blocked", "evidence": ""} for boundary in boundaries],
                    "internalBoundaries": [{**boundary, "decision": "blocked", "evidence": ""} for boundary in packet["internalBoundaries"]],
                    "groups": [], "sections": [], "evidence": []}
        template = work / "structure" / f"response-template-{digest}.json"
        if not template.exists():
            json_write(template, response, 0o444)
        return {"status": "await-explicit-structure-review", "packet": str(destination), "packetSha256": digest,
                "responseTemplate": str(template), "pages": len(pages), "boundaries": len(boundaries)}


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_caption_ledger(work, paper, ledger):
    """Check original caption proof against its exact current UTF-16 location."""
    blocks = {b["blockId"]: b for b in paper["blocks"]}
    figures = {f["figureId"]: f for f in paper["figures"]}
    require(len(ledger["figures"]) == len(figures), "Duplicate or missing figure ledger entry")
    for figure in ledger["figures"]:
        canonical = figures[figure["figureId"]]
        require(not any(s.get("transcription") for bid in canonical["captionBlockIds"] for s in blocks[bid]["sourceSpans"]), "Transcribed figure captions require a separate reviewed caption mapping workflow; this source gate does not support that scenario")
        require(figure["captionBlockIds"] == canonical["captionBlockIds"] and figure["crop"] == canonical["crop"] and "p" + str(figure["sourcePageNumber"]) == canonical["sourcePageId"], "Figure ledger differs from canonical source mapping")
        require(file_hash(within(work, canonical["assetRef"])) == figure["assetSha256"], "Figure asset changed since reviewed source crop")
        evidence = figure.get("captionEvidence", []); mappings = figure.get("captionBlockMappings", [])
        require(evidence and len(evidence) == len(mappings) and len({e["blockId"] for e in evidence}) == len(evidence), "Incomplete original caption evidence/mappings")
        flat = [{"blockId": e["blockId"], "canonicalBlockId": e["canonicalBlockId"], **span} for e in evidence for span in e["sourceSpans"]]
        require(figure.get("captionGlyphRanges") == flat, "Caption glyph ledger differs from original evidence")
        map_by_id = {m["originalBlockId"]: m for m in mappings}
        require(set(map_by_id) == {e["blockId"] for e in evidence}, "Caption mapping identities differ")
        coverage = {bid: [] for bid in figure["captionBlockIds"]}
        for item in evidence:
            mapping = map_by_id[item["blockId"]]; bid = item["canonicalBlockId"]
            require(bid in coverage and mapping["canonicalBlockId"] == bid and _nonempty(item.get("sourceEvidence")), "Caption canonical identity/evidence differs")
            block = blocks[bid]; start, end = mapping["start"], mapping["end"]
            require(type(start) is int and type(end) is int and 0 <= start < end <= u16(block["en"]), "Invalid caption UTF-16 mapping")
            try:
                fragment = block["en"].encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")
            except UnicodeDecodeError as error:
                raise ValueError("Caption mapping cuts a UTF-16 surrogate pair") from error
            require(sha(fragment.encode()) == item["enHash"], "Original caption text changed or mapping is wrong")
            coverage[bid].extend(item["sourceSpans"])
        for bid, spans in coverage.items():
            require(spans == blocks[bid]["sourceSpans"], "Caption source spans must cover the entire canonical caption once in order")


def accept_structure(work, response_path, workers=2):
    import reader
    work = Path(work); response = read(response_path)
    with work_lock(work, operation="accept-source-structure"):
        expected_files = {rel: file_hash(work / rel) for rel in ("paper.json", "source.pdf", "source-manifest.json", "source-inventory/inventory.json", "source-figure-ledger.json", "source-transcription-ledger.json")}
        paper_bytes = (work / "paper.json").read_bytes(); paper = json.loads(paper_bytes)
        packet_hash = response.get("packetSha256", "")
        require(isinstance(packet_hash, str) and re.fullmatch(r"[0-9a-f]{64}", packet_hash), "Invalid structure packet identity")
        packet_file = work / "structure" / f"packet-{packet_hash}.json"
        require(sha(packet_file.read_bytes()) == packet_hash, "Immutable structure packet changed")
        packet = read(packet_file)
        require(response.get("paperSha256") == packet["paperSha256"] == sha(paper_bytes), "Structure response is stale")
        require(response.get("sourceSha256") == packet["sourceSha256"] == sha((work / "source.pdf").read_bytes()), "Structure source changed")
        require(sha((work / "source-inventory/inventory.json").read_bytes()) == packet["inventorySha256"], "Structure inventory changed")
        require(file_hash(work / "source-transcription-ledger.json") == packet.get("sourceTranscriptionLedgerSha256"), "Structure transcription ledger changed")
        require(isinstance(response.get("evidence"), list) and response["evidence"] and all(_nonempty(x) for x in response["evidence"]), "Overall structure review evidence is required")
        require(not any(block.get("zh") for block in paper["blocks"]), "This gate is for pre-translation structure; preserve existing bilingual content with the reviewed migration workflow")
        before_audit = audit_source(work, paper, workers)
        require(before_audit["status"] == "pass", "Independent source audit is not pass: " + json.dumps(before_audit, ensure_ascii=False))
        transcription_proof = {"transcriptionRegions": [], "visualNativeGlyphs": []}
        if expected_files["source-transcription-ledger.json"]:
            transcription_proof = validate_transcription_ledger(paper, read(work / "source-inventory/inventory.json"), read(work / "source-transcription-ledger.json"))
            for mapping in transcription_proof["transcriptionRegions"]:
                block = next(b for b in paper["blocks"] if b["blockId"] == mapping["blockId"])
                block["sourceSpans"][mapping["spanIndex"]].update({key: mapping[key] for key in ("regionId", "textStart", "textEnd")})
        expected_pages = {p["pageId"]: p for p in packet["pages"]}
        reviewed_pages = response.get("pages", [])
        require(len(reviewed_pages) == len(expected_pages) and {p.get("pageId") for p in reviewed_pages} == set(expected_pages), "Every source page requires one explicit review")
        ledger_file = work / "source-figure-ledger.json"
        ledger = read(ledger_file) if ledger_file.exists() else {"schemaVersion": 1, "sourceSha256": paper["sourceSha256"], "inventorySha256": packet["inventorySha256"], "independentOfPaper": True, "figures": [], "figureLedgerComplete": False}
        require(ledger.get("sourceSha256") == paper["sourceSha256"] and ledger.get("inventorySha256") == packet["inventorySha256"], "Source figure ledger identity differs")
        figure_ids = {f["figureId"] for f in paper["figures"]}
        require({f["figureId"] for f in ledger["figures"]} == figure_ids, "Canonical figures must match the independent reviewed figure ledger")
        validate_caption_ledger(work, paper, ledger)
        figure_pages = {f["figureId"]: "p" + str(f["sourcePageNumber"]) for f in ledger["figures"]}; reviewed_figures = set()
        for review in reviewed_pages:
            expected = expected_pages[review["pageId"]]
            require(review.get("status") == "pass" and _nonempty(review.get("evidence")), "Unreviewed source page: " + review["pageId"])
            require(review.get("orderedBlockIds") == expected["orderedBlockIds"], "Page/column reading order must explicitly match reviewed global order")
            region_ids = []
            for decision in review.get("graphics", []):
                require(decision.get("decision") in {"figure", "table", "equation", "decoration", "source-only"} and _nonempty(decision.get("evidence")), "Every graphic region group needs a source decision")
                require(isinstance(decision.get("regionIds"), list) and decision["regionIds"], "Empty source graphic region group")
                if decision["decision"] == "figure":
                    require(decision.get("figureIds") and set(decision["figureIds"]).issubset(figure_ids), "Graphic group references unknown figure")
                    require(all(figure_pages[fid] == review["pageId"] for fid in decision["figureIds"]), "Figure review must refer to its actual source page")
                    reviewed_figures.update(decision["figureIds"])
                region_ids.extend(decision["regionIds"])
            require(len(region_ids) == len(set(region_ids)) and set(region_ids) == set(expected["graphicRegionIds"]), "Graphic source coverage must be complete and nonduplicated")
        require(reviewed_figures == figure_ids, "Every figure needs explicit source-page graphic coverage")
        decisions = response.get("boundaries", []); expected_boundaries = {b["boundaryId"]: b for b in packet["boundaries"]}
        require(len(decisions) == len(expected_boundaries) and {b.get("boundaryId") for b in decisions} == set(expected_boundaries), "Every adjacency/cross-column/cross-page boundary needs an explicit decision")
        decision_map = {}
        for decision in decisions:
            expected = expected_boundaries[decision["boundaryId"]]
            require(decision.get("decision") in {"same", "different", "heading", "figure-interruption"} and _nonempty(decision.get("evidence")), "Incomplete boundary decision")
            require(all(decision.get(key) == expected[key] for key in ("leftBlockId", "rightBlockId", "requiredAspects")), "Boundary identity/aspects changed")
            if decision["decision"] == "figure-interruption":
                require(decision.get("continuation") in {"same", "different"}, "Figure interruption must explicitly say whether paragraph continues")
            decision_map[decision["boundaryId"]] = decision
        internal = response.get("internalBoundaries", []); expected_internal = {b["boundaryId"]: b for b in packet["internalBoundaries"]}
        require(len(internal) == len(expected_internal) and {b.get("boundaryId") for b in internal} == set(expected_internal), "Every existing within-block source transition needs explicit review")
        for decision in internal:
            expected = expected_internal[decision["boundaryId"]]
            require(all(decision.get(key) == value for key, value in expected.items()) and _nonempty(decision.get("evidence")), "Internal boundary identity/evidence is incomplete")
            require(decision.get("decision") == "same" or decision.get("decision") == "figure-interruption" and decision.get("continuation") == "same", "Existing block contains a noncontinuing source boundary; split it with explicit provenance before approval")
        blocks = {b["blockId"]: b for b in paper["blocks"]}; groups = response.get("groups", [])
        caption_owners = {bid: {f["figureId"] for f in paper["figures"] if bid in f["captionBlockIds"]} for bid in blocks}
        require(groups and [bid for group in groups for bid in group.get("blockIds", [])] == packet["orderedBlockIds"], "Groups must partition the entire reviewed order without gaps or reordering")
        old_to_new, offsets, new_blocks = {}, {}, []
        for group in groups:
            require(group.get("kind") in KINDS and _nonempty(group.get("evidence")), "Each paragraph classification needs source evidence")
            ids = group["blockIds"]; first = ids[0]; kind = group["kind"]
            require(all(caption_owners[bid] == caption_owners[first] for bid in ids), "Different figure-caption assignments cannot merge")
            require(all(blocks[bid]["kind"] in {"body", kind} for bid in ids), "Heading/caption/content-type barrier cannot be merged across")
            require(not any(blocks[bid]["kind"] == "heading" for bid in ids) or len(ids) == 1, "Existing source headings cannot merge with adjacent blocks")
            joiner = group.get("joiner", " ")
            require(isinstance(joiner, str) and len(joiner) <= 2 and not joiner.strip(), "Joiner can only add reviewed whitespace")
            merged = copy.deepcopy(blocks[first]); text = ""; spans = []
            for index, bid in enumerate(ids):
                if index:
                    text += joiner
                offsets[bid] = u16(text); old_to_new[bid] = first; text += blocks[bid]["en"]
                source_spans = copy.deepcopy(blocks[bid]["sourceSpans"])
                for span in source_spans:
                    if span.get("transcription"):
                        span["textStart"] += offsets[bid]; span["textEnd"] += offsets[bid]
                spans.extend(source_spans)
            merged.update(kind=kind, en=text, enHash=sha(text.encode()), zh="", zhHash=sha(b""), sourceSpans=spans, order=len(new_blocks), translationStatus="original-only" if kind in EXEMPT else "pending")
            if kind in EXEMPT:
                require(_nonempty(group.get("exclusionReason")), "Excluded source glyphs need an explicit reason")
                merged["exclusionReason"] = group["exclusionReason"]
            else:
                merged.pop("exclusionReason", None)
            new_blocks.append(merged)
        for boundary in packet["boundaries"]:
            decision = decision_map[boundary["boundaryId"]]
            same = decision["decision"] == "same" or decision["decision"] == "figure-interruption" and decision["continuation"] == "same"
            require(same == (old_to_new[boundary["leftBlockId"]] == old_to_new[boundary["rightBlockId"]]), "Boundary decision disagrees with canonical paragraph grouping")
            if decision["decision"] == "heading":
                require(any(b["kind"] == "heading" for b in new_blocks if b["blockId"] in {old_to_new[boundary["leftBlockId"]], old_to_new[boundary["rightBlockId"]]}), "Heading boundary needs a canonical heading")
        output = copy.deepcopy(paper); output["blocks"] = new_blocks
        if expected_files["source-transcription-ledger.json"]:
            output["sourceTranscriptionLedgerSha256"] = expected_files["source-transcription-ledger.json"]
        # Compose only repairs already verified against the real PDF above.
        # Retain their verbatim evidence; grouping does not invent new repairs.
        inventory_pages = {p["pageId"]: p for p in read(work / "source-inventory/inventory.json")["pages"]}
        merged_edits = []; consumed = set()
        for group in groups:
            if len(group["blockIds"]) < 2:
                continue
            old_edits = [e for e in paper.get("sourceEdits", []) if e.get("blockId") in group["blockIds"]]
            if old_edits:
                new_block = next(b for b in new_blocks if b["blockId"] == group["blockIds"][0])
                skip = {(v["blockId"], v["pageId"], v["glyphIndex"]) for v in transcription_proof["visualNativeGlyphs"]}
                by_span = {(v["blockId"], v["spanIndex"]): v["en"] for v in transcription_proof["transcriptionRegions"]}
                raw = "".join(by_span[(bid, index)] if span.get("transcription") else "".join(inventory_pages[span["pageId"]]["glyphs"][i]["text"] for i in range(span["glyphStart"], span["glyphEnd"]) if (bid, span["pageId"], i) not in skip) for bid in group["blockIds"] for index, span in enumerate(blocks[bid]["sourceSpans"]))
                merged_edits.append({"blockId": new_block["blockId"], "before": raw, "after": new_block["en"],
                                     "reason": "Compose previously source-verified repairs across explicitly reviewed paragraph grouping",
                                     "sourceEvidence": "Preserved source repairs: " + json.dumps(old_edits, ensure_ascii=False, sort_keys=True),
                                     "originalSourceEdits": copy.deepcopy(old_edits), "structureEvidence": group["evidence"]})
                consumed.update(group["blockIds"])
        output["sourceEdits"] = [e for e in output.get("sourceEdits", []) if e.get("blockId") not in consumed] + merged_edits
        sections = copy.deepcopy(response.get("sections", []))
        require(sections and all(_nonempty(s.get("sectionId")) and isinstance(s.get("titleEn"), str) and isinstance(s.get("titleZh"), str) for s in sections), "Explicit source sections are required")
        require(len({s["sectionId"] for s in sections}) == len(sections), "Duplicate section identity")
        membership = [bid for section in sections for bid in section.get("blockIds", [])]
        require(membership == [b["blockId"] for b in new_blocks], "Sections must preserve complete approved paragraph order")
        output["sections"] = sections
        for collection in ("formatting", "inlineReferences"):
            shifted = []
            for item in output[collection]:
                value = copy.deepcopy(item); bid = value["blockId"]; delta = offsets[bid]
                value["blockId"] = old_to_new[bid]; value["start"] += delta; value["end"] += delta
                for target in value.get("targets", []):
                    target["start"] += delta; target["end"] += delta
                shifted.append(value)
            output[collection] = shifted
        mappings = []
        for mapping in output.get("idMap", []):
            value = copy.deepcopy(mapping); bid = value["newBlockId"]
            value["newBlockId"] = old_to_new[bid]; value["newStart"] += offsets[bid]; value["newEnd"] += offsets[bid]; mappings.append(value)
        for group in groups:
            if len(group["blockIds"]) > 1:
                for bid in group["blockIds"]:
                    text = blocks[bid]["en"]
                    if text:
                        mappings.append({"oldBlockId": bid, "newBlockId": old_to_new[bid], "language": "en", "oldStart": 0, "oldEnd": u16(text), "newStart": offsets[bid], "newEnd": offsets[bid] + u16(text), "oldText": text, "newText": text})
        output["idMap"] = list({sha(encoded(mapping)): mapping for mapping in mappings}.values())
        for figure in output["figures"]:
            figure["captionBlockIds"] = list(dict.fromkeys(old_to_new[bid] for bid in figure["captionBlockIds"]))
        for figure in ledger["figures"]:
            figure.setdefault("originalCaptionBlockIds", figure["captionBlockIds"][:])
            figure["captionBlockIds"] = list(dict.fromkeys(old_to_new[bid] for bid in figure["captionBlockIds"]))
            for mapping in figure["captionBlockMappings"]:
                bid = mapping["canonicalBlockId"]
                mapping["canonicalBlockId"] = old_to_new[bid]; mapping["start"] += offsets[bid]; mapping["end"] += offsets[bid]
            for item in figure["captionEvidence"] + figure["captionGlyphRanges"]:
                item["canonicalBlockId"] = old_to_new[item["canonicalBlockId"]]
        output["contentFingerprint"] = reader.fingerprint(output)
        require(not reader.validate_id_map(output), "Invalid resulting UTF-16 identity mapping")
        validate_caption_ledger(work, output, ledger)
        after_audit = audit_source(work, output, workers)
        require(after_audit["status"] == "pass", "Grouped source failed independent audit")
        ledger.update(figureLedgerComplete=True, pageReviews=reviewed_pages, structurePacketSha256=packet_hash,
                      sourceEvidence=response["evidence"], provenance={"input": "source.pdf", "tool": "source_pipeline+explicit-agent-review"})
        approval = {"schemaVersion": 1, "status": "approved", "sourceSha256": output["sourceSha256"], "structureFingerprint": structure_fingerprint(output),
                    "paperSha256Before": sha(paper_bytes), "packetSha256": packet_hash, "evidence": response["evidence"], "pageReviewCount": len(reviewed_pages),
                    "boundaryReviewCount": len(decisions), "internalBoundaryReviewCount": len(internal), "blockCount": len(new_blocks), "sourceAudit": after_audit}
        if expected_files["source-transcription-ledger.json"]:
            approval["sourceTranscriptionLedgerSha256"] = expected_files["source-transcription-ledger.json"]
        manifest = read(work / "source-manifest.json")
        manifest["coverage"] = [{"pageId": p["pageId"], "regions": [{"blockId": b["blockId"], "kind": b["kind"], "spans": [s for s in b["sourceSpans"] if s["pageId"] == p["pageId"]]} for b in new_blocks if p["pageId"] in _page_ids(b)]} for p in output["pages"]]
        changes = {"paper.json": encoded(output), "source-manifest.json": encoded(manifest), "structure-approval.json": encoded(approval),
                   "structure-review.json": encoded(response), "source-audit.json": encoded(after_audit), "source-figure-ledger.json": encoded(ledger)}
        journal = _commit(work, changes, expected_files)
        return {**approval, "journal": journal}


def batch_crop(work, request_paths):
    """Render each approved (source page, scale) once; merge all results once."""
    import reader
    import pypdfium2
    work = Path(work)
    paths = [request_paths] if isinstance(request_paths, (str, Path)) else list(request_paths)
    require(paths, "At least one reviewed figure task output is required")
    with work_lock(work, operation="batch-source-crop"):
        expected_files = {rel: file_hash(work / rel) for rel in ("paper.json", "source.pdf", "source-manifest.json", "source-inventory/inventory.json", "source-figure-ledger.json", "source-transcription-ledger.json")}
        paper_bytes = (work / "paper.json").read_bytes(); paper = json.loads(paper_bytes)
        source_hash = sha((work / "source.pdf").read_bytes()); inventory_file = work / "source-inventory/inventory.json"
        inventory_hash = sha(inventory_file.read_bytes()); inventory = read(inventory_file)
        require(source_hash == paper["sourceSha256"] == inventory["sourceSha256"], "Figure tasks do not share the actual source PDF")
        tasks = []; inputs = []
        for path in paths:
            payload = Path(path).read_bytes(); request = json.loads(payload)
            require(request.get("sourceSha256") == source_hash and request.get("paperSha256") == sha(paper_bytes), "Stale or foreign figure task output")
            require(isinstance(request.get("figures"), list) and request["figures"], "Figure task has no reviewed crop")
            tasks.extend(request["figures"]); inputs.append({"path": str(Path(path)), "sha256": sha(payload)})
        existing = {f["figureId"] for f in paper["figures"]}; blocks = {b["blockId"]: b for b in paper["blocks"]}
        ids = [f.get("figureId") for f in tasks]
        require(len(ids) == len(set(ids)) and not (set(ids) & existing), "Duplicate/existing figure IDs cannot be overwritten")
        groups = {}
        for figure in tasks:
            require(isinstance(figure.get("figureId"), str) and re.fullmatch(r"(main|extended|supplement):\d+", figure["figureId"]), "Explicit figure scope and number required")
            number = figure.get("sourcePageNumber", figure.get("pageNumber"))
            require(type(number) is int and 1 <= number <= inventory["pageCount"], "Invalid original PDF page number")
            page = inventory["pages"][number - 1]; box = figure.get("crop")
            require(isinstance(box, list) and len(box) == 4 and all(type(x) in {int, float} and math.isfinite(x) for x in box), "Invalid reviewed crop coordinates")
            require(0 <= box[0] < box[2] <= page["width"] and 0 <= box[1] < box[3] <= page["height"], "Crop exceeds source page")
            scale = figure.get("scale", 4)
            require(type(scale) in {int, float} and math.isfinite(scale) and scale >= 2, "Crop scale must be at least 2; default is 4")
            require(figure.get("reviewed") is True and _nonempty(figure.get("sourceEvidence")), "Crop boundaries require explicit original-page review")
            captions = figure.get("captionBlockIds", []); decisions = figure.get("captionEvidence", [])
            require(captions and len(captions) == len(set(captions)) and all(bid in blocks for bid in captions), "Every figure needs explicit canonical caption IDs")
            require(len(decisions) == len(captions) and {d.get("blockId") for d in decisions} == set(captions), "Each caption requires independent reviewed source ranges")
            for decision in decisions:
                block = blocks[decision["blockId"]]
                require(not any(s.get("transcription") for s in block["sourceSpans"]), "Transcribed figure captions require a separate reviewed caption mapping workflow; batch-crop does not support that scenario")
                require(block["kind"] in {"body", "caption"}, "Caption assignment crosses a known heading/content-type barrier")
                require(decision.get("enHash") == block["enHash"] == sha(block["en"].encode()) and decision.get("sourceSpans") == block["sourceSpans"] and _nonempty(decision.get("sourceEvidence")), "Caption source evidence/ranges do not match reviewed source")
            figure["sourcePageNumber"] = number; figure["scale"] = scale
            groups.setdefault((number, scale), []).append(figure)
        output = copy.deepcopy(paper); output_blocks = {b["blockId"]: b for b in output["blocks"]}
        ledger_file = work / "source-figure-ledger.json"
        ledger = read(ledger_file) if ledger_file.exists() else {"schemaVersion": 1, "sourceSha256": source_hash, "inventorySha256": inventory_hash,
                                                               "independentOfPaper": True, "provenance": {"input": "source.pdf", "tool": "source_pipeline+explicit-agent-crop-review"}, "figures": [], "taskInputs": []}
        require(ledger.get("sourceSha256") == source_hash and ledger.get("inventorySha256") == inventory_hash, "Existing figure ledger source differs")
        changes, render_records = {}, []
        document = pypdfium2.PdfDocument(str(work / "source.pdf"))
        try:
            for (number, scale), figures in sorted(groups.items()):
                page = document[number - 1]; bitmap = page.render(scale=scale); image = bitmap.to_pil()
                render_records.append({"sourcePageNumber": number, "scale": scale, "pixelWidth": image.width, "pixelHeight": image.height, "figures": [f["figureId"] for f in figures]})
                for figure in figures:
                    box = figure["crop"]
                    pixels = [max(0, math.floor(box[0] * scale)), max(0, math.floor(box[1] * scale)), min(image.width, math.ceil(box[2] * scale)), min(image.height, math.ceil(box[3] * scale))]
                    cropped = image.crop(tuple(pixels)); stream = BytesIO(); cropped.save(stream, format="PNG"); data = stream.getvalue(); cropped.close()
                    asset = "figures/" + figure["figureId"].replace(":", "-") + ".png"
                    require(not (work / asset).exists(), "Refuse to overwrite an unrelated figure asset")
                    changes[asset] = data
                    scope, figure_number = figure["figureId"].split(":")
                    output["figures"].append({"figureId": figure["figureId"], "scope": scope, "number": int(figure_number), "sourcePageId": f"p{number}", "crop": box,
                                               "assetRef": asset, "captionBlockIds": figure["captionBlockIds"], "panelLabels": figure.get("panelLabels", []),
                                               "representation": {"kind": "source-page-crop", "scale": scale, "originalPdf": "source.pdf", "pixelBox": pixels}})
                    for bid in figure["captionBlockIds"]:
                        output_blocks[bid]["kind"] = "caption"
                    ledger["figures"].append({"figureId": figure["figureId"], "sourcePageNumber": number, "crop": box, "scale": scale, "pixelBox": pixels,
                                              "sourceEvidence": figure["sourceEvidence"], "captionBlockIds": figure["captionBlockIds"],
                                              "captionEvidence": [{**decision, "canonicalBlockId": decision["blockId"]} for decision in figure["captionEvidence"]],
                                              "captionGlyphRanges": [{"blockId": decision["blockId"], "canonicalBlockId": decision["blockId"], **span} for decision in figure["captionEvidence"] for span in decision["sourceSpans"]],
                                              "captionBlockMappings": [{"originalBlockId": bid, "canonicalBlockId": bid, "start": 0, "end": u16(blocks[bid]["en"])} for bid in figure["captionBlockIds"]],
                                              "assetSha256": sha(data)})
                image.close(); bitmap.close(); page.close()
        finally:
            document.close()
        require(sha((work / "source.pdf").read_bytes()) == source_hash, "Source PDF changed during batch rendering")
        ledger["taskInputs"].extend(inputs); ledger["figureLedgerComplete"] = False
        ledger["lastRenderGroups"] = render_records
        output["contentFingerprint"] = reader.fingerprint(output)
        changes.update({"paper.json": encoded(output), "source-figure-ledger.json": encoded(ledger)})
        journal = _commit(work, changes, expected_files)
        return {"status": "await-structure-and-graphic-coverage-review", "figures": len(tasks), "renderCount": len(render_records), "renderGroups": render_records,
                "ledger": str(ledger_file), "journal": journal, "structureApproval": "existing approval, if any, is stale until structure is reviewed again"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract"); extract.add_argument("pdf", type=Path); extract.add_argument("--out", type=Path, required=True); extract.add_argument("--workers", type=int, default=2); extract.add_argument("--scale", type=float, default=2)
    inventory = commands.add_parser("inventory"); inventory.add_argument("pdf", type=Path); inventory.add_argument("--out", type=Path, required=True); inventory.add_argument("--workers", type=int, default=2); inventory.add_argument("--raster-scale", type=float)
    audit = commands.add_parser("audit"); audit.add_argument("work", type=Path); audit.add_argument("--workers", type=int, default=2)
    packets = commands.add_parser("structure-packets"); packets.add_argument("work", type=Path); packets.add_argument("--order", type=Path)
    accept = commands.add_parser("accept-structure"); accept.add_argument("work", type=Path); accept.add_argument("response", type=Path); accept.add_argument("--workers", type=int, default=2)
    crop = commands.add_parser("batch-crop"); crop.add_argument("work", type=Path); crop.add_argument("requests", type=Path, nargs="+")
    args = parser.parse_args(argv)
    if args.command == "extract":
        result = extract_source(args.pdf, args.out, args.workers, args.scale)
    elif args.command == "inventory":
        result = create_inventory(args.pdf, args.out, args.workers, args.raster_scale)
    elif args.command == "audit":
        result = audit_source(args.work, workers=args.workers)
    elif args.command == "structure-packets":
        result = structure_packets(args.work, read(args.order) if args.order else None)
    elif args.command == "accept-structure":
        result = accept_structure(args.work, args.response, args.workers)
    else:
        result = batch_crop(args.work, args.requests)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get("status") in {"fail", "blocked"} else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
