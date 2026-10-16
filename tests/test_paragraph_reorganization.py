"""Explicit, source-reviewed paragraph joins; no geometry-based auto-merge.

Run: python -m unittest discover -s tests -p test_paragraph_reorganization.py -v
The fixtures are generic text. Physical page/column coordinates are evidence,
not a rule: a sentence-ending period and a flush column start can belong to
one paragraph, while a real new paragraph must remain separate.
"""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import reader as r


def units(text):
    return len(text.encode("utf-16-le")) // 2


def slice16(text, start, end):
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def interval(text, token):
    start = text.index(token)
    return {"start": units(text[:start]), "end": units(text[:start + len(token)])}


def span(page, start, end, x=20, y=700):
    return {"pageId": page, "glyphStart": start, "glyphEnd": end,
            "bbox": [x, y, x + 220, y + 12]}


def block(bid, order, en, zh, spans, kind="body"):
    return {"blockId": bid, "order": order, "kind": kind, "en": en, "zh": zh,
            "enHash": r.textsha(en), "zhHash": r.textsha(zh),
            "translationStatus": "reviewed", "reviewEvidence": "Old separate-block review: " + bid,
            "sourceSpans": spans, "candidateColumn": 0, "bbox": spans[0]["bbox"]}


def fixture(kind="body"):
    a = block("part-a", 0, "😀 A result ended here.", "😀这里结束一句。",
              [span("p1", 0, 3, 310), span("p2", 0, 4)], kind)
    b = block("part-b", 1, "The next sentence continued with italic2 and Fig. 1a, b.",
              "下一句继续含斜体2与图1a、b。", [span("p2", 4, 7, 310)], kind)
    c = block("part-c", 2, "It ended on the following page.", "这一段在下一页结束。",
              [span("p3", 0, 4, 20, 60)], kind)
    tail = block("new-paragraph", 3, "A new paragraph begins.", "一个真正的新段开始。",
                 [span("p3", 4, 8, 28, 90)])
    p = {"schemaVersion": 1, "documentId": "generic-paragraph-fixture",
         "sourceSha256": "f" * 64, "metadata": {"titleEn": "Generic boundary fixture"},
         "pages": [{"pageId": "p" + str(i), "number": i, "width": 600, "height": 800,
                    "rotation": 0, "assetRef": "pages/p" + str(i) + ".png"} for i in range(1, 4)],
         "sections": [{"sectionId": "science", "titleEn": "Results", "titleZh": "结果",
                       "blockIds": ["part-a", "part-b", "part-c", "new-paragraph"]}],
         "blocks": [a, b, c, tail],
         "figures": [{"figureId": "main:1", "scope": "main", "number": 1,
                      "sourcePageId": "p2", "crop": [20, 30, 580, 650],
                      "assetRef": "figures/main-1.png", "captionBlockIds": [],
                      "panelLabels": ["a", "b"], "representation": "source-crop"}],
         "formatting": [], "inlineReferences": [], "idMap": [], "issues": [],
         "sourceEdits": [{"blockId": "new-paragraph", "before": "para-\ngraph",
                          "after": "paragraph", "reason": "Reviewed line-break reconstruction",
                          "sourceEvidence": "p3 source glyphs"}]}
    for lang, italic, raised in [("en", "italic", "2"), ("zh", "斜体", "2")]:
        for token, style in [(italic, "italic"), (raised, "sup")]:
            p["formatting"].append({"blockId": b["blockId"], "language": lang,
                                    **interval(b[lang], token), "kind": style,
                                    "sourceEvidence": "p2 original font: " + style})
        label = "Fig. 1a, b" if lang == "en" else "图1a、b"
        target_tokens = ["Fig. 1a", "b"] if lang == "en" else ["图1a", "b"]
        p["inlineReferences"].append({"blockId": b["blockId"], "language": lang,
                                      **interval(b[lang], label), "exactText": label,
                                      "figureIds": ["main:1"], "panelLabels": ["a", "b"],
                                      "sourceEvidence": "Reviewed compound figure scope",
                                      "targets": [{**interval(b[lang], token), "exactText": token,
                                                   "figureIds": ["main:1"], "panelLabels": [panel]}
                                                  for token, panel in zip(target_tokens, ["a", "b"])]})
        old_token = "continued" if lang == "en" else "继续"
        pos = interval(b[lang], old_token)
        p["idMap"].append({"oldBlockId": "legacy-b", "newBlockId": b["blockId"],
                           "language": lang, "oldStart": 0, "oldEnd": units(old_token),
                           "newStart": pos["start"], "newEnd": pos["end"],
                           "oldText": old_token, "newText": old_token,
                           "sourceEvidence": "Earlier explicit split mapping"})
    p["idMap"].append({"oldBlockId": "legacy-tail", "newBlockId": tail["blockId"],
                       "language": "en", "oldStart": 0, "oldEnd": 1,
                       "newStart": 0, "newEnd": 1, "oldText": "A", "newText": "A"})
    p["contentFingerprint"] = r.fingerprint(p)
    return p


def request(ids=("part-a", "part-b", "part-c"), decision="same"):
    return {"blockIds": list(ids), "decision": decision, "joiners": {"en": " ", "zh": ""},
            "sourceEvidence": "Original pages p1/p2/p3 reviewed: the period is inside one paragraph; "
                              "p2 right column continues at the normal edge below a large figure."}


def get_block(p, bid):
    return next(b for b in p["blocks"] if b["blockId"] == bid)


class ReviewedParagraphJoins(unittest.TestCase):
    def reject_without_mutating(self, p, req):
        before, req_before = copy.deepcopy(p), copy.deepcopy(req)
        with self.assertRaises(ValueError):
            r.merge_reviewed_paragraphs(p, req)
        self.assertEqual(p, before)
        self.assertEqual(req, req_before)

    def test_three_pages_period_column_join_is_exact_and_pure(self):
        p, req = fixture(), request()
        before, req_before = copy.deepcopy(p), copy.deepcopy(req)
        manifest = {"pages": [{"pageId": "p1"}, {"pageId": "p2"}, {"pageId": "p3"}]}
        old_review = r.review_fingerprint(p, manifest)
        new = r.merge_reviewed_paragraphs(p, req)
        merged = get_block(new, "part-a")
        self.assertEqual(p, before)
        self.assertEqual(req, req_before)
        self.assertIsNot(new, p)
        self.assertEqual([b["blockId"] for b in sorted(new["blocks"], key=lambda b: b["order"])],
                         ["part-a", "new-paragraph"])
        self.assertEqual(new["sections"][0]["blockIds"], ["part-a", "new-paragraph"])
        for lang, joiner in req["joiners"].items():
            self.assertEqual(merged[lang], joiner.join(get_block(before, bid)[lang] for bid in req["blockIds"]))
            self.assertEqual(merged[lang + "Hash"], r.textsha(merged[lang]))
        self.assertIn("here. The next", merged["en"])
        self.assertIn("一句。下一句", merged["zh"])
        expected_spans = [s for bid in req["blockIds"] for s in get_block(before, bid)["sourceSpans"]]
        self.assertEqual(merged["sourceSpans"], expected_spans)
        self.assertEqual({s["pageId"] for s in merged["sourceSpans"]}, {"p1", "p2", "p3"})
        self.assertEqual(new["figures"], before["figures"])
        self.assertEqual(new["sourceEdits"][:len(before["sourceEdits"])], before["sourceEdits"])
        self.assertIn(req["sourceEvidence"], json.dumps(new, ensure_ascii=False))
        self.assertEqual(new["documentId"], before["documentId"])
        self.assertEqual(new["sourceSha256"], before["sourceSha256"])
        self.assertEqual(new["pages"], before["pages"])
        self.assertEqual(new["issues"], before["issues"])
        for key, value in get_block(before, "new-paragraph").items():
            if key != "order":
                self.assertEqual(get_block(new, "new-paragraph")[key], value)
        self.assertEqual(merged["translationStatus"], "needs-review")
        self.assertNotIn(merged.get("reviewEvidence"), [get_block(before, bid)["reviewEvidence"] for bid in req["blockIds"]])
        self.assertNotEqual(r.review_fingerprint(new, manifest), old_review)
        self.assertNotEqual(new.get("contentFingerprint"), before["contentFingerprint"])
        # A returned paper must own its nested records, too.
        merged["sourceSpans"][0]["bbox"][0] = -999
        self.assertEqual(p, before)
        # The provenance decision is a snapshot, rather than mutable aliases
        # of a caller's request. Editing either side must not change the other.
        req["blockIds"].append("later-unrelated-request")
        req["joiners"]["zh"] = " "
        self.assertEqual(new["paragraphMerges"][-1]["oldBlockIds"], req_before["blockIds"])
        self.assertEqual(new["paragraphMerges"][-1]["joiners"], req_before["joiners"])

    def test_utf16_formats_compound_targets_and_existing_maps_shift_exactly(self):
        p = fixture()
        new = r.merge_reviewed_paragraphs(p, request())
        merged = get_block(new, "part-a")
        # The leading emoji contributes two JS code units. EN also adds a space;
        # ZH intentionally has no separator. Python character offsets are wrong.
        offsets = {lang: units(get_block(p, "part-a")[lang]) + units(joiner)
                   for lang, joiner in {"en": " ", "zh": ""}.items()}
        self.assertNotEqual(offsets["en"], len(get_block(p, "part-a")["en"]) + 1)
        for original, actual in zip(p["formatting"], new["formatting"]):
            expected = {**original, "blockId": "part-a", "start": original["start"] + offsets[original["language"]],
                        "end": original["end"] + offsets[original["language"]]}
            self.assertEqual(actual, expected)
            self.assertEqual(slice16(merged[actual["language"]], actual["start"], actual["end"]),
                             slice16(get_block(p, "part-b")[original["language"]], original["start"], original["end"]))
        self.assertEqual(len(new["formatting"]), len(p["formatting"]))
        for original, actual in zip(p["inlineReferences"], new["inlineReferences"]):
            offset = offsets[original["language"]]
            expected = copy.deepcopy(original)
            expected.update(blockId="part-a", start=original["start"] + offset, end=original["end"] + offset)
            for target in expected["targets"]:
                target["start"] += offset
                target["end"] += offset
            self.assertEqual(actual, expected)
            self.assertEqual(slice16(merged[actual["language"]], actual["start"], actual["end"]), actual["exactText"])
            for target in actual["targets"]:
                self.assertEqual(slice16(merged[actual["language"]], target["start"], target["end"]), target["exactText"])
        self.assertEqual(len(new["inlineReferences"]), len(p["inlineReferences"]))
        for old in p["idMap"]:
            actual = next(m for m in new["idMap"] if m["oldBlockId"] == old["oldBlockId"] and m["language"] == old["language"])
            expected = copy.deepcopy(old)
            if old["newBlockId"] == "part-b":
                expected.update(newBlockId="part-a", newStart=old["newStart"] + offsets[old["language"]],
                                newEnd=old["newEnd"] + offsets[old["language"]])
            self.assertEqual(actual, expected)
        for lang, joiner in {"en": " ", "zh": ""}.items():
            cursor = 0
            for bid in ("part-a", "part-b", "part-c"):
                old_text = get_block(p, bid)[lang]
                maps = [m for m in new["idMap"] if m["oldBlockId"] == bid and m["language"] == lang]
                self.assertEqual(len(maps), 1)
                expected = {"oldBlockId": bid, "newBlockId": "part-a", "language": lang,
                            "oldStart": 0, "oldEnd": units(old_text), "newStart": cursor,
                            "newEnd": cursor + units(old_text), "oldText": old_text, "newText": old_text}
                self.assertEqual({k: maps[0][k] for k in expected}, expected)
                self.assertEqual(slice16(merged[lang], maps[0]["newStart"], maps[0]["newEnd"]), old_text)
                cursor += units(old_text) + units(joiner)

    def test_pure_figure_page_does_not_break_reviewed_science_section(self):
        p = fixture()
        a, b = get_block(p, "part-a"), get_block(p, "part-b")
        a["sourceSpans"] = [span("p1", 0, 3)]
        b["sourceSpans"] = [span("p3", 0, 4, 20, 60)]
        cap = block("figure-caption", 4, "An image caption.", "图的说明。", [span("p2", 0, 7)], "caption")
        p["blocks"] = [a, b, cap]
        p["sections"][0]["blockIds"] = ["part-a", "part-b"]
        p["sections"].append({"sectionId": "captions", "titleEn": "Captions", "titleZh": "图注", "blockIds": [cap["blockId"]]})
        p["figures"][0]["captionBlockIds"] = [cap["blockId"]]
        p["idMap"] = [m for m in p["idMap"] if m["oldBlockId"] != "legacy-tail"]
        p["sourceEdits"] = []
        new = r.merge_reviewed_paragraphs(p, request(("part-a", "part-b")))
        self.assertEqual([s["pageId"] for s in get_block(new, "part-a")["sourceSpans"]], ["p1", "p3"])
        self.assertEqual({k: v for k, v in get_block(new, "figure-caption").items() if k != "order"},
                         {k: v for k, v in cap.items() if k != "order"})
        self.assertEqual(new["figures"], p["figures"])
        self.assertEqual(new["sections"][1], p["sections"][1])

    def test_only_allowed_same_kind_segments_can_be_joined(self):
        for kind in ("body", "methods", "caption"):
            with self.subTest(kind=kind):
                p = fixture(kind)
                if kind == "caption":
                    p["figures"][0]["captionBlockIds"] = ["part-a", "part-b", "part-c"]
                new = r.merge_reviewed_paragraphs(p, request())
                self.assertEqual(get_block(new, "part-a")["kind"], kind)
                if kind == "caption":
                    self.assertEqual(new["figures"][0]["captionBlockIds"], ["part-a"])
        for barrier in ("heading", "caption", "reference", "figure-label"):
            with self.subTest(barrier=barrier):
                p = fixture()
                get_block(p, "part-b")["kind"] = barrier
                self.reject_without_mutating(p, request())
        p = fixture("heading")
        self.reject_without_mutating(p, request())

    def test_true_new_paragraph_and_missing_review_are_rejected(self):
        p = fixture()
        # The true next paragraph is indented on p3. The human decision alone
        # authorizes a merge; neither a page boundary nor coordinates override it.
        self.reject_without_mutating(p, request(("part-c", "new-paragraph"), "different"))
        req = request()
        del req["decision"]
        self.reject_without_mutating(p, req)
        req = request()
        req["sourceEvidence"] = "   "
        self.reject_without_mutating(p, req)

    def test_section_boundary_reading_gap_and_reversed_ids_are_rejected(self):
        p = fixture()
        self.reject_without_mutating(p, request(("part-a", "part-c")))
        self.reject_without_mutating(p, request(("part-b", "part-a")))
        p["sections"][0]["blockIds"] = ["part-a", "part-c", "new-paragraph"]
        p["sections"].append({"sectionId": "separate", "titleEn": "Another section", "titleZh": "另一节", "blockIds": ["part-b"]})
        self.reject_without_mutating(p, request(("part-a", "part-b")))

    def test_freeze_default_does_not_merge_any_paragraph_candidates(self):
        p = fixture()
        before = copy.deepcopy(p)
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            r.write(work / "paper.json", p)
            r.write(work / "source-manifest.json", {"pages": p["pages"]})
            self.assertEqual(r.freeze(work)["status"], "frozen")
            frozen = r.read(work / "paper.json")
            self.assertEqual(frozen["blocks"], before["blocks"])
            self.assertEqual(frozen["sections"], before["sections"])
            self.assertEqual(frozen["idMap"], before["idMap"])
            self.assertEqual(frozen["sourceEdits"], before["sourceEdits"])
            self.assertEqual(frozen["contentFingerprint"], before["contentFingerprint"])
            self.assertEqual(len(frozen["blocks"]), 4)


class ParagraphMappingValidation(unittest.TestCase):
    def test_id_map_rejects_bad_identity_utf16_range_text_and_target(self):
        p = fixture()
        self.assertEqual(r.validate_id_map(p), [])
        changes = [
            {"oldBlockId": ""}, {"language": "de"}, {"newBlockId": "missing"},
            {"oldStart": -1}, {"oldStart": True}, {"oldEnd": 0},
            {"newStart": -1}, {"newEnd": 999}, {"oldText": "changed"},
            {"newText": "changed"},
            # Equal-length single-code-unit ranges still cannot cut an emoji.
            {"oldStart": 0, "oldEnd": 1, "newBlockId": "part-a", "newStart": 0,
             "newEnd": 1, "oldText": "x", "newText": "x"},
        ]
        for change in changes:
            with self.subTest(change=change):
                bad = copy.deepcopy(p)
                bad["idMap"][0].update(change)
                before = copy.deepcopy(bad)
                self.assertTrue(r.validate_id_map(bad))
                self.assertEqual(bad, before)
        bad = copy.deepcopy(p)
        bad["idMap"] = {"legacy-b": p["idMap"][0]}
        self.assertTrue(r.validate_id_map(bad))

    def test_duplicate_and_ambiguous_overlap_fail_but_adjacent_ranges_pass(self):
        p = fixture()
        duplicate = copy.deepcopy(p)
        duplicate["idMap"].append(copy.deepcopy(duplicate["idMap"][0]))
        self.assertTrue(any("duplicate" in e.lower() for e in r.validate_id_map(duplicate)))
        original = p["idMap"][0]
        left = {**original, "oldEnd": 4, "newEnd": original["newStart"] + 4,
                "oldText": "cont", "newText": "cont"}
        right = {**original, "oldStart": 4, "newStart": original["newStart"] + 4,
                 "oldText": "inued", "newText": "inued"}
        adjacent = copy.deepcopy(p)
        adjacent["idMap"] = [left, right]
        self.assertEqual(r.validate_id_map(adjacent), [])
        overlap = copy.deepcopy(p)
        overlap["idMap"] = [copy.deepcopy(original), right]
        self.assertTrue(any("Overlapping" in e for e in r.validate_id_map(overlap)))
        # Two exact quotes at different valid destinations are still ambiguous
        # for a note from the same old paragraph range.
        ambiguous = copy.deepcopy(p)
        tail = get_block(ambiguous, "new-paragraph")
        tail["en"] = "The word continued again."
        tail["enHash"] = r.textsha(tail["en"])
        pos = interval(tail["en"], "continued")
        ambiguous["idMap"].append({**original, "newBlockId": "new-paragraph",
                                    "newStart": pos["start"], "newEnd": pos["end"]})
        before = copy.deepcopy(ambiguous)
        self.assertTrue(any("Overlapping" in e for e in r.validate_id_map(ambiguous)))
        with self.assertRaises(ValueError):
            r.merge_reviewed_paragraphs(ambiguous, request())
        self.assertEqual(ambiguous, before)

    def test_equivalent_old_map_segments_are_normalized_on_repeated_join(self):
        p = fixture()
        p["idMap"].append(copy.deepcopy(p["idMap"][0]))
        first = r.merge_reviewed_paragraphs(p, request(("part-a", "part-b")))
        self.assertEqual(r.validate_id_map(first), [])
        self.assertEqual(len([m for m in first["idMap"] if m["oldBlockId"] == "legacy-b" and m["language"] == "en"]), 1)
        second = r.merge_reviewed_paragraphs(first, request(("part-a", "part-c")))
        self.assertEqual(r.validate_id_map(second), [])
        for lang in ("en", "zh"):
            maps = [m for m in second["idMap"] if m["oldBlockId"] == "part-a" and m["language"] == lang]
            self.assertEqual(len(maps), 1)
            self.assertEqual(maps[0]["oldText"], get_block(first, "part-a")[lang])
            for m in [m for m in second["idMap"] if m["language"] == lang]:
                target = get_block(second, m["newBlockId"])[lang]
                self.assertEqual(slice16(target, m["newStart"], m["newEnd"]), m["newText"])


class ParagraphTargetPipelineValidation(unittest.TestCase):
    def test_internal_targets_reject_new_range_text_scope_and_surrogate_errors(self):
        # Use the existing real extraction fixture so this exercises validate(),
        # including page assets, original glyph ownership and source identities.
        from make_samples import make
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            work = root / "work"
            r.extract(make(root), work)
            p = r.read(work / "paper.json")
            b = p["blocks"][0]
            b.update(en="😀 Fig. 1a and a.", zh="😀图1a及a。")
            b["enHash"], b["zhHash"] = r.textsha(b["en"]), r.textsha(b["zh"])
            ref = {"blockId": b["blockId"], "language": "en", **interval(b["en"], "Fig. 1a"),
                   "exactText": "Fig. 1a", "figureIds": ["main:1"], "panelLabels": ["a"],
                   "targets": [{**interval(b["en"], "Fig. 1a"), "exactText": "Fig. 1a",
                                "figureIds": ["main:1"], "panelLabels": ["a"]}]}
            p["formatting"] = []
            p["inlineReferences"] = [ref]
            p["contentFingerprint"] = r.fingerprint(p)
            r.write(work / "paper.json", p)
            self.assertEqual(r.validate(work)["content"]["errors"], [])
            last_a = b["en"].rfind("a")
            start = units(b["en"][:last_a])
            invalid_targets = [
                {"start": ref["start"] - 1, "exactText": " Fig. 1a"},
                {"start": start, "end": start + 1, "exactText": "a"},
                {"end": units(b["en"]) + 1},
                {"exactText": "different reference"},
                {"figureIds": ["extended:1"]},
            ]
            for change in invalid_targets:
                with self.subTest(change=change):
                    bad = copy.deepcopy(p)
                    bad["inlineReferences"][0]["targets"][0].update(change)
                    r.write(work / "paper.json", bad)
                    errors = r.validate(work)["content"]["errors"]
                    self.assertTrue(any("figure target" in e for e in errors), errors)
            # A whole-text outer reference contains the attempted one-unit
            # target, so the UTF-16 surrogate check itself must reject it.
            bad = copy.deepcopy(p)
            outer = bad["inlineReferences"][0]
            outer.update(start=0, end=units(b["en"]), exactText=b["en"])
            outer["targets"][0].update(start=0, end=1, exactText="x")
            r.write(work / "paper.json", bad)
            self.assertIn("Invalid text range/block/language", r.validate(work)["content"]["errors"])
            # Main validate() must call the mapping gate, rather than leaving
            # invalid note-migration maps to the helper's unit tests alone.
            valid_map = {"oldBlockId": "legacy-reference", "newBlockId": b["blockId"],
                         "language": "en", "oldStart": 0, "oldEnd": units(ref["exactText"]),
                         "newStart": ref["start"], "newEnd": ref["end"],
                         "oldText": ref["exactText"], "newText": ref["exactText"]}
            valid = copy.deepcopy(p)
            valid["idMap"] = [valid_map]
            r.write(work / "paper.json", valid)
            self.assertEqual(r.validate(work)["content"]["errors"], [])
            for label, maps in [
                ("bad target", [{**valid_map, "newBlockId": "missing"}]),
                ("duplicate", [valid_map, copy.deepcopy(valid_map)]),
                ("overlap", [valid_map, {**valid_map, "oldStart": 5, "newStart": ref["start"] + 5,
                                         "oldText": "1a", "newText": "1a"}]),
            ]:
                with self.subTest(id_map=label):
                    bad = copy.deepcopy(p)
                    bad["idMap"] = maps
                    r.write(work / "paper.json", bad)
                    errors = r.validate(work)["content"]["errors"]
                    self.assertTrue(any("idMap" in e for e in errors), errors)


if __name__ == "__main__":
    unittest.main()
