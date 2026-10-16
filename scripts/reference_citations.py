"""Source-bound bibliography/citation annotations; never changes scientific text.

Discovery is deliberately separate from approval.  Typography and a numeric
regular expression cannot distinguish a citation from an exponent or a unit.
Only a reviewed source decision can enter ``referenceCitations``.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path

ELIGIBLE_KINDS = frozenset({"body", "methods", "caption"})
SUPER_DIGITS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")
_NUMBER_RUN = r"[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*[-–−—]\s*[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+)?(?:\s*[,，]\s*[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s*[-–−—]\s*[0-9⁰¹²³⁴⁵⁶⁷⁸⁹]+)?)*"
_BRACKET = re.compile(r"\[\s*(" + _NUMBER_RUN + r")\s*\]|［\s*(" + _NUMBER_RUN + r")\s*］")
_PAREN = re.compile(r"\(\s*(" + _NUMBER_RUN + r")\s*\)|（\s*(" + _NUMBER_RUN + r")\s*）")
_SUPER = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:[,，–−—-][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*")
_PREFIX = re.compile(r"^\s*(?:\[(\d+)\]|［(\d+)］|(\d+)[.)]|(\d+)(?=\s))\s*")


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def u16len(value):
    return len(value.encode("utf-16-le")) // 2


def u16slice(value, start, end):
    if not isinstance(value, str) or not _int(start) or not _int(end) or not 0 <= start < end <= u16len(value):
        raise ValueError("invalid UTF-16 span")
    try:
        return value.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise ValueError("UTF-16 span splits a surrogate pair") from exc


def _hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def citation_id(block_id, language, start, end):
    """Stable for one canonical span, independent of the renderer or its styling."""
    payload = json.dumps([block_id, language, start, end], ensure_ascii=False, separators=(",", ":"))
    return "refcite-" + _hash(payload)[:20]


def parse_label(label, max_expansion=10000):
    """Expand literal numeric labels, retaining first lexical appearance order.

    No sorting, descending range repair, year removal, or punctuation inference.
    Semantic decisions (e.g. whether '(2020)' is a year) belong to source review.
    """
    if not isinstance(label, str):
        raise ValueError("citation label must be text")
    s = label.strip().translate(SUPER_DIGITS)
    pairs = {"[": "]", "［": "］", "(": ")", "（": "）"}
    if s and s[0] in pairs:
        if not s.endswith(pairs[s[0]]):
            raise ValueError("unbalanced citation delimiters")
        s = s[1:-1].strip()
    if not re.fullmatch(_NUMBER_RUN, s):
        raise ValueError("label is not a numeric citation list")
    values, seen = [], set()
    for item in re.split(r"[,，]", s):
        limits = re.split(r"[-–−—]", item.strip())
        if any(len(x.strip()) > 7 for x in limits):
            raise ValueError("citation number too large")
        nums = [int(x.strip()) for x in limits]
        if any(n < 1 for n in nums) or (len(nums) == 2 and nums[1] < nums[0]):
            raise ValueError("citation numbers must be positive; ranges must ascend")
        last = nums[-1]
        if last - nums[0] + 1 > max_expansion:
            raise ValueError("citation range is too large")
        for number in range(nums[0], last + 1):
            if number not in seen:
                values.append(number)
                seen.add(number)
                if len(values) > max_expansion:
                    raise ValueError("citation list is too large")
    return values


def _prefix(text):
    match = _PREFIX.match(text)
    if not match:
        return None
    number = int(next(x for x in match.groups() if x is not None))
    return (number, match.end()) if number > 0 else None


def _blocks(paper):
    return {b.get("blockId"): b for b in paper.get("blocks", []) if isinstance(b, dict)}


def _metadata_block_ids(paper):
    result = set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "blockId" and isinstance(item, str):
                    result.add(item)
                elif key.endswith("BlockIds") or key == "blockIds":
                    if isinstance(item, list):
                        result.update(x for x in item if isinstance(x, str))
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(paper.get("articleInfo", {}))
    return result


def _pages(manifest):
    return {p.get("pageId"): p for p in manifest.get("pages", []) if isinstance(p, dict)}


def _block_glyphs(block, manifest):
    """Return ordered, unique (pageId, index, glyph) owned by this block."""
    pages, seen, result = _pages(manifest), set(), []
    for span in block.get("sourceSpans", []):
        if not isinstance(span, dict) or span.get("transcription"):
            raise ValueError("glyph provenance unavailable; source review is unresolved")
        pid, start, end = span.get("pageId"), span.get("glyphStart"), span.get("glyphEnd")
        glyphs = pages.get(pid, {}).get("glyphs", [])
        if not _int(start) or not _int(end) or not 0 <= start < end <= len(glyphs):
            raise ValueError("invalid source glyph provenance")
        for index in range(start, end):
            key = (pid, index)
            if key in seen:
                raise ValueError("duplicate source glyph provenance")
            glyph = glyphs[index]
            if not isinstance(glyph, dict) or not isinstance(glyph.get("text"), str):
                raise ValueError("invalid source glyph text")
            seen.add(key)
            result.append((pid, index, glyph))
    if not result:
        raise ValueError("missing source glyph provenance")
    return result


def _source_map(block, manifest):
    """Match complete EN text to owned glyphs, ignoring whitespace alone.

    Any non-whitespace mismatch refuses an automatic map.  Source edits,
    ligature substitutions, reordered glyphs or dehyphenation are not guessed.
    """
    glyphs = _block_glyphs(block, manifest)
    source_chars = [(char, pid, index) for pid, index, glyph in glyphs for char in glyph["text"] if not char.isspace()]
    canonical = [(char, offset) for offset, char in enumerate(block.get("en", "")) if not char.isspace()]
    if "".join(c for c, *_ in source_chars) != "".join(c for c, _ in canonical):
        raise ValueError("canonical EN and ordered PDF glyphs do not map exactly except whitespace")
    return {offset: (pid, index) for (_, offset), (_, pid, index) in zip(canonical, source_chars)}


def _ranges(keys):
    result = []
    for pid, index in dict.fromkeys(keys):
        if result and result[-1]["pageId"] == pid and result[-1]["glyphEnd"] == index:
            result[-1]["glyphEnd"] = index + 1
        else:
            result.append({"pageId": pid, "glyphStart": index, "glyphEnd": index + 1})
    return result


def _range_keys(evidence):
    ranges = evidence.get("glyphRanges")
    if ranges is None and all(k in evidence for k in ("pageId", "glyphStart", "glyphEnd")):
        ranges = [{k: evidence[k] for k in ("pageId", "glyphStart", "glyphEnd")}]
    if not isinstance(ranges, list) or not ranges:
        raise ValueError("source evidence needs nonempty glyphRanges")
    keys = []
    for item in ranges:
        if not isinstance(item, dict):
            raise ValueError("invalid evidence glyph range")
        pid, start, end = item.get("pageId"), item.get("glyphStart"), item.get("glyphEnd")
        if not isinstance(pid, str) or not _int(start) or not _int(end) or not 0 <= start < end or end - start > 100000:
            raise ValueError("invalid evidence glyph range")
        keys.extend((pid, n) for n in range(start, end))
    if len(keys) != len(set(keys)):
        raise ValueError("source evidence repeats glyphs")
    return keys


def make_source_evidence(paper, manifest, block_id, start, end, *, role="inline-citation", review_note=None):
    """Create exact glyph evidence; a review note is required to approve inline use.

    This helper does not perform the human/agent semantic review represented by
    ``review_note``.  Calling it without that note yields unapproved evidence.
    """
    block = _blocks(paper)[block_id]
    text = block["en"]
    u16slice(text, start, end)
    start_py = len(text.encode("utf-16-le")[:start * 2].decode("utf-16-le"))
    end_py = len(text.encode("utf-16-le")[:end * 2].decode("utf-16-le"))
    mapping = _source_map(block, manifest)
    keys = list(dict.fromkeys(mapping[i] for i in range(start_py, end_py) if i in mapping))
    pages = _pages(manifest)
    result = {"sourceSha256": paper["sourceSha256"], "role": role, "verification": "glyph-map", "glyphRanges": _ranges(keys), "exactText": "".join(pages[p]["glyphs"][i]["text"] for p, i in keys)}
    if review_note:
        result.update(classification="bibliographic-citation", reviewNote=review_note)
    return result


def _evidence_glyphs(paper, manifest, block, evidence, role):
    if not isinstance(evidence, dict) or evidence.get("sourceSha256") != paper.get("sourceSha256") or evidence.get("role") != role:
        raise ValueError("missing source evidence or source identity/role mismatch")
    if evidence.get("verification") not in {"glyph-map", "reviewed-source"}:
        raise ValueError("unknown source verification method")
    owned = {(p, i): g for p, i, g in _block_glyphs(block, manifest)}
    keys = _range_keys(evidence)
    if any(key not in owned for key in keys):
        raise ValueError("evidence glyphs are not owned by this canonical block")
    text = "".join(owned[key]["text"] for key in keys)
    if not isinstance(evidence.get("exactText"), str) or text != evidence["exactText"]:
        raise ValueError("source evidence exactText differs from original PDF glyphs")
    return keys, text


def _semantic_review(evidence):
    if evidence.get("classification") != "bibliographic-citation" or not isinstance(evidence.get("reviewNote"), str) or not evidence["reviewNote"].strip():
        raise ValueError("citation semantics have not been explicitly reviewed against source")


def _target_error(paper, manifest, target, blocks):
    number, bid = target.get("number"), target.get("blockId")
    if not _int(number) or number <= 0 or not isinstance(bid, str) or bid not in blocks or blocks[bid].get("kind") != "reference":
        raise ValueError("target needs positive number and existing reference-kind block")
    block, evidence = blocks[bid], target.get("sourceEvidence")
    keys, quoted = _evidence_glyphs(paper, manifest, block, evidence, "bibliography-prefix")
    glyphs = _block_glyphs(block, manifest)
    source = "".join(g["text"] for _, _, g in glyphs)
    prefix = _prefix(source)
    if prefix is None or prefix[0] != number or not _prefix(quoted) or _prefix(quoted)[0] != number:
        raise ValueError("target number is not the actual source numbered prefix")
    # Evidence must contain every non-whitespace source prefix glyph and no
    # non-prefix glyphs; merely finding the same number later cannot qualify.
    consumed, expected = 0, []
    for pid, index, glyph in glyphs:
        if consumed < prefix[1] and glyph["text"].strip():
            expected.append((pid, index))
        consumed += len(glyph["text"])
    nonspace_keys = [key for key in keys if next(g for p, i, g in glyphs if (p, i) == key)["text"].strip()]
    if nonspace_keys != expected:
        raise ValueError("target evidence does not identify the leading source prefix")
    canonical = _prefix(block.get("en", ""))
    if canonical and canonical[0] != number:
        raise ValueError("canonical bibliography prefix contradicts source number")
    if canonical is None:
        if evidence.get("verification") != "reviewed-source" or not isinstance(evidence.get("reviewNote"), str) or not evidence["reviewNote"].strip():
            raise ValueError("missing canonical prefix needs explicit reviewed-source explanation")


def build_reference_targets(paper, manifest):
    """Derive source-proven numbered targets; duplicate/ambiguous ones stay unresolved."""
    targets, unresolved = [], []
    for block in paper.get("blocks", []):
        if block.get("kind") != "reference":
            continue
        try:
            glyphs = _block_glyphs(block, manifest)
            source = "".join(g["text"] for _, _, g in glyphs)
            found = _prefix(source)
            canonical = _prefix(block.get("en", ""))
            if not found or not canonical or found[0] != canonical[0]:
                raise ValueError("source and canonical numbered prefix are not confirmed")
            consumed, selected = 0, []
            for pid, index, glyph in glyphs:
                if consumed < found[1]:
                    selected.append((pid, index, glyph))
                consumed += len(glyph["text"])
            evidence = {"sourceSha256": paper.get("sourceSha256"), "role": "bibliography-prefix", "verification": "glyph-map", "glyphRanges": _ranges((p, i) for p, i, _ in selected), "exactText": "".join(g["text"] for _, _, g in selected)}
            targets.append({"number": found[0], "blockId": block["blockId"], "sourceEvidence": evidence})
        except (ValueError, KeyError, TypeError) as exc:
            unresolved.append({"blockId": block.get("blockId"), "status": "unresolved", "reason": str(exc)})
    duplicate_numbers = {t["number"] for t in targets if sum(x["number"] == t["number"] for x in targets) > 1}
    duplicate_blocks = {t["blockId"] for t in targets if sum(x["blockId"] == t["blockId"] for x in targets) > 1}
    approved = []
    for target in targets:
        if target["number"] in duplicate_numbers or target["blockId"] in duplicate_blocks:
            unresolved.append({"blockId": target["blockId"], "number": target["number"], "status": "unresolved", "reason": "duplicate bibliography number or block"})
        else:
            approved.append(target)
    return {"targets": approved, "unresolved": unresolved}


def _candidate(block, language, start, end, style):
    text = u16slice(block[language], start, end)
    return {"id": citation_id(block["blockId"], language, start, end), "blockId": block["blockId"], "language": language, "start": start, "end": end, "exactText": text, "numbers": parse_label(text), "style": style, "status": "unresolved", "reason": "numeric candidate only; source citation semantics require explicit review"}


def discover_candidates(paper, manifest=None):
    """Find numeric syntax/formatting candidates; never returns approved links.

    Years, equations, Fig./Table references and numeric metadata can resemble
    citations.  Candidates in prose stay unlinked until reviewed; ineligible
    block kinds and article-info metadata are excluded entirely.
    """
    found, blocks = {}, _blocks(paper)
    metadata_ids = _metadata_block_ids(paper)
    def add(block, lang, start, end, style):
        if block.get("kind") not in ELIGIBLE_KINDS or block.get("blockId") in metadata_ids:
            return
        try:
            candidate = _candidate(block, lang, start, end, style)
        except (ValueError, KeyError, TypeError):
            return
        found.setdefault((block["blockId"], lang, start, end), candidate)
    for block in blocks.values():
        if block.get("kind") not in ELIGIBLE_KINDS:
            continue
        for lang in ("en", "zh"):
            text = block.get(lang, "")
            if not isinstance(text, str):
                continue
            for pattern, style in ((_BRACKET, "bracket"), (_PAREN, "parenthetical"), (_SUPER, "superscript")):
                for match in pattern.finditer(text):
                    add(block, lang, u16len(text[:match.start()]), u16len(text[:match.end()]), style)
    for entry in paper.get("formatting", []):
        if not isinstance(entry, dict) or entry.get("kind") != "sup" or entry.get("blockId") not in blocks:
            continue
        add(blocks[entry["blockId"]], entry.get("language"), entry.get("start"), entry.get("end"), "superscript")
    # Fresh manifests can expose superscript typography before formatting is
    # annotated. Geometry here only discovers candidates, never approves them.
    if manifest is not None:
        for block in blocks.values():
            if block.get("kind") not in ELIGIBLE_KINDS:
                continue
            try:
                mapping = _source_map(block, manifest)
                owned = {(p, i): g for p, i, g in _block_glyphs(block, manifest)}
            except (ValueError, KeyError, TypeError):
                continue
            text = block.get("en", "")
            for match in re.finditer(_NUMBER_RUN, text):
                keys = list(dict.fromkeys(mapping[i] for i in range(match.start(), match.end()) if i in mapping))
                neighbors = [mapping[i] for i in range(max(0, match.start() - 30), min(len(text), match.end() + 30)) if i in mapping and text[i].isalpha()]
                if not keys or not neighbors:
                    continue
                selected = [owned[key] for key in keys]
                raised = False
                for key in neighbors:
                    base = owned[key]
                    if all(p == key[0] for p, _ in keys) and all(_raised_relative(glyph, base) for glyph in selected):
                        raised = True
                        break
                if raised:
                    add(block, "en", u16len(text[:match.start()]), u16len(text[:match.end()]), "superscript")
    return sorted(found.values(), key=lambda c: (blocks[c["blockId"]].get("order", 0), c["blockId"], c["language"], c["start"], c["end"]))


def _raised_relative(glyph, base):
    try:
        a, b = glyph["bbox"], base["bbox"]
        size, base_size = float(glyph["size"]), float(base["size"])
        return 0 < size <= base_size * 0.85 and b[1] - base_size * .6 <= a[1] <= b[1] + base_size * .25 and a[3] <= b[3] - base_size * .1 and abs(a[0] - b[0]) < base_size * 35
    except (KeyError, ValueError, TypeError, IndexError):
        return False


def source_candidate_inventory(manifest):
    """Independent PDF-glyph syntax inventory; takes no paper/canonical text.

    This exposes possible omissions from a paper-built index, not a claim that
    regex/geometry exhaust scientific citations.  Every candidate requires a
    source-page disposition; page-level visual review is still required.
    """
    records, page_records = [], []
    source_hash = manifest.get("sourceSha256")
    for page in manifest.get("pages", []):
        pid, glyphs = page["pageId"], page.get("glyphs", [])
        page_records.append({"pageId": pid, "glyphCount": len(glyphs), "glyphFingerprint": _hash(json.dumps(glyphs, sort_keys=True, ensure_ascii=False, separators=(",", ":")))})
        lines = []
        # A separate baseline group retains the source superscript typography;
        # normal text is searched separately for bracket/parenthetical syntax.
        for index, glyph in sorted(enumerate(glyphs), key=lambda pair: (pair[1]["bbox"][3], pair[1]["bbox"][0], pair[0])):
            bottom, size = glyph["bbox"][3], glyph.get("size", 0)
            line = next((row for row in reversed(lines[-12:]) if abs(row["bottom"] - bottom) <= 1.0 and abs(row["size"] - size) <= max(1.0, size * .15)), None)
            if line is None:
                line = {"bottom": bottom, "size": size, "items": []}
                lines.append(line)
            line["items"].append((index, glyph))
        seen = set()
        for line in lines:
            chars, owners, previous = [], [], None
            for index, glyph in sorted(line["items"], key=lambda item: (item[1]["bbox"][0], item[0])):
                if previous is not None:
                    gap = glyph["bbox"][0] - previous["bbox"][2]
                    if gap > max(1.5, glyph.get("size", 0) * .15):
                        # A column/gutter gap starts a new source segment; do
                        # not merge bracket labels or miss its numbered prefix.
                        chars.append("\n" if gap > max(12, glyph.get("size", 0) * 1.5) else " ")
                        owners.append(None)
                for char in glyph["text"]:
                    chars.append(char)
                    owners.append(index)
                previous = glyph
            text = "".join(chars)
            possibilities, offset = [], 0
            for segment in text.split("\n"):
                possibilities.extend((offset + match.start(), offset + match.end(), style, "inline-citation") for pattern, style in ((_BRACKET, "bracket"), (_PAREN, "parenthetical")) for match in pattern.finditer(segment))
                prefix = _prefix(segment)
                if prefix:
                    possibilities.append((offset, offset + prefix[1], "numbered-prefix", "bibliography-prefix"))
                offset += len(segment) + 1
            for match in re.finditer(_NUMBER_RUN, text):
                indices = list(dict.fromkeys(i for i in owners[match.start():match.end()] if i is not None))
                if indices and any(all(_raised_relative(glyphs[index], base) for index in indices) for base in glyphs if any(c.isalpha() for c in base["text"])):
                    possibilities.append((match.start(), match.end(), "superscript", "inline-citation"))
            for start, end, style, role in possibilities:
                indices = list(dict.fromkeys(i for i in owners[start:end] if i is not None))
                key = (role, tuple(indices))
                if not indices or key in seen:
                    continue
                seen.add(key)
                raw = "".join(glyphs[index]["text"] for index in indices)
                try:
                    numbers = [_prefix(raw)[0]] if role == "bibliography-prefix" and _prefix(raw) else parse_label(raw)
                except (ValueError, TypeError):
                    continue
                ranges = _ranges((pid, index) for index in indices)
                identity = json.dumps([source_hash, role, ranges, raw], sort_keys=True, ensure_ascii=False, separators=(",", ":"))
                records.append({"sourceCandidateId": "source-ref-" + _hash(identity)[:20], "pageId": pid, "role": role, "style": style, "glyphRanges": ranges, "exactText": raw, "numbers": numbers, "bbox": [min(glyphs[i]["bbox"][0] for i in indices), min(glyphs[i]["bbox"][1] for i in indices), max(glyphs[i]["bbox"][2] for i in indices), max(glyphs[i]["bbox"][3] for i in indices)], "status": "unresolved", "reason": "PDF glyph syntax/geometry candidate; semantic source review required"})
    return {"schemaVersion": 1, "sourceSha256": source_hash, "documentId": manifest.get("documentId"), "scope": "PDF-only syntax/geometry candidate inventory; page-by-page source review required for completeness", "pages": page_records, "candidates": records}


def _citation_shape(citation, blocks, target_numbers):
    bid, lang = citation.get("blockId"), citation.get("language")
    if not isinstance(bid, str) or bid not in blocks or blocks[bid].get("kind") not in ELIGIBLE_KINDS or lang not in {"en", "zh"}:
        raise ValueError("citation must reference existing body/methods/caption EN/ZH text")
    block = blocks[bid]
    exact = u16slice(block.get(lang), citation.get("start"), citation.get("end"))
    if exact != citation.get("exactText"):
        raise ValueError("citation exactText does not match canonical UTF-16 span")
    numbers = citation.get("numbers")
    if not isinstance(numbers, list) or not numbers or any(not _int(n) or n <= 0 for n in numbers) or len(numbers) != len(set(numbers)):
        raise ValueError("citation numbers must be unique positive integers")
    if parse_label(exact) != numbers:
        raise ValueError("citation numbers do not equal literal label in lexical order")
    if any(number not in target_numbers for number in numbers):
        raise ValueError("citation points to an absent or unverified bibliography number")
    if "style" in citation and citation["style"] not in {"superscript", "bracket", "parenthetical"}:
        raise ValueError("unknown citation display style")
    expected_id = citation_id(bid, lang, citation["start"], citation["end"])
    if "id" in citation and citation["id"] != expected_id:
        raise ValueError("citation id does not match its canonical span")
    return block, expected_id


def _verify_en(paper, manifest, block, citation):
    evidence = citation.get("sourceEvidence")
    keys, source_text = _evidence_glyphs(paper, manifest, block, evidence, "inline-citation")
    _semantic_review(evidence)
    if parse_label(source_text) != citation["numbers"]:
        raise ValueError("source glyph label disagrees with citation numbers/order")
    if evidence["verification"] == "glyph-map":
        expected = make_source_evidence(paper, manifest, block["blockId"], citation["start"], citation["end"])
        if keys != _range_keys(expected):
            raise ValueError("source glyph evidence belongs to a different canonical occurrence")
    else:
        # A visual source decision can bridge a legitimate recorded source edit,
        # but must bind the entire current canonical text and exact occurrence.
        if evidence.get("canonicalTextHash") != _hash(block["en"]) or evidence.get("canonicalStart") != citation["start"] or evidence.get("canonicalEnd") != citation["end"]:
            raise ValueError("reviewed-source evidence must bind canonical text hash and exact UTF-16 occurrence")


def _verify_zh(paper, citation, approved_en):
    source_id = citation.get("sourceEnCitationId")
    source = approved_en.get(source_id)
    if not source or source["blockId"] != citation["blockId"] or source["numbers"] != citation["numbers"]:
        raise ValueError("translation citation needs same-block approved EN citation with identical ordered numbers")
    evidence = citation.get("sourceEvidence")
    if not isinstance(evidence, dict) or evidence.get("role") != "translation-citation" or evidence.get("verification") != "paired-source" or evidence.get("sourceSha256") != paper.get("sourceSha256"):
        raise ValueError("translation citation source identity/role/verification mismatch")
    if not isinstance(evidence.get("reviewNote"), str) or not evidence["reviewNote"].strip():
        raise ValueError("translation citation requires explicit localized-span review")
    if evidence.get("sourceEnCitationId", source_id) != source_id:
        raise ValueError("translation evidence EN pairing differs from citation pairing")


def audit_reference_citations(paper, manifest=None):
    """Read-only audit; errors invalidate links, unresolved candidates stay warnings.

    Empty/absent v1.6 fields are backward compatible.  A manifest is mandatory
    when source-backed records are present. This is not a scientific text audit.
    """
    errors, warnings = [], []
    counts = {"targets": 0, "enCitations": 0, "zhCitations": 0, "unresolvedCandidates": 0}
    result = {"status": "pass", "errors": errors, "warnings": warnings, "counts": counts}
    targets, citations, candidates = (paper.get(key, []) for key in ("referenceTargets", "referenceCitations", "referenceCitationCandidates"))
    for name, value in (("referenceTargets", targets), ("referenceCitations", citations), ("referenceCitationCandidates", candidates)):
        if not isinstance(value, list):
            errors.append(name + " must be an array")
    if errors:
        result["status"] = "fail"
        return result
    counts["unresolvedCandidates"] = len(candidates)
    if candidates:
        warnings.append(f"{len(candidates)} unresolved numeric candidates remain unlinked")
    if not targets and not citations:
        result["status"] = "partial" if warnings else "pass"
        return result
    if not isinstance(manifest, dict) or manifest.get("sourceSha256") != paper.get("sourceSha256") or manifest.get("documentId") != paper.get("documentId"):
        errors.append("citation source manifest missing or source/document identity mismatch")
        result["status"] = "fail"
        return result
    blocks = _blocks(paper)
    if len(blocks) != len(paper.get("blocks", [])):
        errors.append("reference audit cannot use duplicate canonical block IDs")
    if len(_pages(manifest)) != len(manifest.get("pages", [])):
        errors.append("reference audit cannot use duplicate source page IDs")
    seen_numbers, seen_blocks, valid_targets = set(), set(), set()
    duplicate_numbers = {t.get("number") for t in targets if isinstance(t, dict) and _int(t.get("number")) and sum(isinstance(x, dict) and x.get("number") == t.get("number") for x in targets) > 1}
    duplicate_blocks = {t.get("blockId") for t in targets if isinstance(t, dict) and isinstance(t.get("blockId"), str) and sum(isinstance(x, dict) and x.get("blockId") == t.get("blockId") for x in targets) > 1}
    for index, target in enumerate(targets):
        try:
            if not isinstance(target, dict):
                raise ValueError("target must be an object")
            _target_error(paper, manifest, target, blocks)
            if target["number"] in duplicate_numbers or target["blockId"] in duplicate_blocks:
                raise ValueError("bibliography target numbers and block IDs must each be unique")
            seen_numbers.add(target["number"])
            seen_blocks.add(target["blockId"])
            valid_targets.add(target["number"])
            counts["targets"] += 1
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            errors.append(f"referenceTargets[{index}]: {exc}")
    prepared, spans = [], {}
    metadata_ids = _metadata_block_ids(paper)
    for index, citation in enumerate(citations):
        try:
            if not isinstance(citation, dict):
                raise ValueError("citation must be an object")
            block, cid = _citation_shape(citation, blocks, valid_targets)
            if citation["blockId"] in metadata_ids:
                raise ValueError("numeric article metadata and author affiliations cannot be citations")
            group = (citation["blockId"], citation["language"])
            for start, end in spans.setdefault(group, []):
                if max(start, citation["start"]) < min(end, citation["end"]):
                    raise ValueError("citation spans overlap or repeat")
            for figure in paper.get("inlineReferences", []):
                if figure.get("blockId") == citation["blockId"] and figure.get("language") == citation["language"] and max(figure["start"], citation["start"]) < min(figure["end"], citation["end"]):
                    raise ValueError("bibliography citation overlaps a figure/table reference")
            spans[group].append((citation["start"], citation["end"]))
            prepared.append((index, citation, block, cid))
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            errors.append(f"referenceCitations[{index}]: {exc}")
    approved_en, used_source_glyphs = {}, set()
    for index, citation, block, cid in prepared:
        if citation["language"] != "en":
            continue
        try:
            _verify_en(paper, manifest, block, citation)
            source_keys = set(_range_keys(citation["sourceEvidence"]))
            if source_keys & used_source_glyphs:
                raise ValueError("one source glyph occurrence cannot approve multiple EN citations")
            used_source_glyphs.update(source_keys)
            approved_en[cid] = citation
            counts["enCitations"] += 1
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            errors.append(f"referenceCitations[{index}]: {exc}")
    used_pairs = set()
    for index, citation, _, _ in prepared:
        if citation["language"] != "zh":
            continue
        try:
            _verify_zh(paper, citation, approved_en)
            if citation["sourceEnCitationId"] in used_pairs:
                raise ValueError("one EN occurrence cannot approve multiple localized occurrences")
            used_pairs.add(citation["sourceEnCitationId"])
            counts["zhCitations"] += 1
        except (ValueError, TypeError, KeyError, IndexError) as exc:
            errors.append(f"referenceCitations[{index}]: {exc}")
    result["status"] = "fail" if errors else "partial" if warnings else "pass"
    return result


def validate_reference_citations(paper, manifest=None):
    return audit_reference_citations(paper, manifest)["errors"]


def build_reference_citations(paper, manifest, reviewed_spans):
    """Build annotations from explicit reviewed decisions, returning audit report.

    Each input supplies blockId/language/start/end plus sourceEvidence (or an EN
    reviewNote for exact glyph-map evidence). ZH additionally supplies
    sourceEnCitationId and reviewNote. No text or input object is modified.
    """
    records, unresolved = [], []
    blocks = _blocks(paper)
    for decision in reviewed_spans:
        try:
            block = blocks[decision["blockId"]]
            lang, start, end = decision["language"], decision["start"], decision["end"]
            exact = u16slice(block[lang], start, end)
            record = {"id": citation_id(block["blockId"], lang, start, end), "blockId": block["blockId"], "language": lang, "start": start, "end": end, "exactText": exact, "numbers": parse_label(exact)}
            if "style" in decision:
                record["style"] = decision["style"]
            if "sourceEvidence" in decision:
                record["sourceEvidence"] = copy.deepcopy(decision["sourceEvidence"])
            elif lang == "en":
                record["sourceEvidence"] = make_source_evidence(paper, manifest, block["blockId"], start, end, review_note=decision.get("reviewNote"))
            else:
                record["sourceEvidence"] = {"sourceSha256": paper.get("sourceSha256"), "role": "translation-citation", "verification": "paired-source", "reviewNote": decision.get("reviewNote", "")}
            if lang == "zh":
                record["sourceEnCitationId"] = decision.get("sourceEnCitationId")
            records.append(record)
        except (ValueError, KeyError, TypeError) as exc:
            unresolved.append({"blockId": decision.get("blockId") if isinstance(decision, dict) else None, "status": "unresolved", "reason": str(exc)})
    candidate = copy.deepcopy(paper)
    candidate["referenceCitations"] = records
    audit = audit_reference_citations(candidate, manifest)
    return {"citations": records if not audit["errors"] else [], "proposedCitations": records, "unresolved": unresolved, "audit": audit}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("audit", "discover", "targets", "inventory"))
    parser.add_argument("paper", type=Path, nargs="?")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--out", type=Path, help="Separate report; never writes the input paper")
    args = parser.parse_args(argv)
    if args.command != "inventory" and not args.paper:
        parser.error("this command requires paper.json")
    paper = json.loads(args.paper.read_text(encoding="utf-8")) if args.paper else None
    manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else None
    if args.command == "inventory":
        if manifest is None:
            parser.error("inventory requires --manifest")
        result = source_candidate_inventory(manifest)
    elif args.command == "audit":
        result = audit_reference_citations(paper, manifest)
    elif args.command == "targets":
        if manifest is None:
            parser.error("targets requires --manifest")
        result = build_reference_targets(paper, manifest)
    else:
        result = {"candidates": discover_candidates(paper, manifest)}
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        if args.out.resolve() in {p.resolve() for p in (args.paper, args.manifest) if p}:
            parser.error("report must not overwrite paper or manifest")
        args.out.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 1 if result.get("errors") else 0


if __name__ == "__main__":
    raise SystemExit(main())
