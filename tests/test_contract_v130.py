"""Navigation/state contract tests using self-authored fixtures, not scientific review."""
import ast
import copy
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import reader as r


def toc_node(item_id="methods-entry", target="methods", **extra):
    return {"id": item_id, "titleEn": "Methods", "titleZh": "方法", "role": "source", "targetId": target, **extra}


def navigation_fixture():
    kinds = [("method-title", "heading"), ("method-body", "methods"), ("legend", "caption"), ("figure-label", "figure-label"), ("page-header", "header-footer")]
    blocks = [{"blockId": bid, "kind": kind, "order": i, "en": bid, "zh": "自拟" + bid, "sourceSpans": []} for i, (bid, kind) in enumerate(kinds)]
    return {"blocks": blocks, "sections": [{"sectionId": "methods", "titleEn": "Methods", "titleZh": "方法", "blockIds": ["method-title", "method-body"]}, {"sectionId": "caption-only", "titleEn": "Figure", "titleZh": "图", "blockIds": ["legend", "figure-label", "page-header"]}], "toc": {"version": 1, "items": [toc_node(children=[toc_node("method-subentry", "method-title")])]}}


class TocContract(unittest.TestCase):
    def test_valid_hierarchy_and_shared_group_destination_preserve_input(self):
        paper = navigation_fixture()
        paper["toc"]["items"][0]["role"] = "navigation-group"
        paper["toc"]["items"][0]["children"].append(toc_node("same-source", "methods"))
        before = copy.deepcopy(paper)
        self.assertEqual(r.validate_toc(paper), [])
        self.assertEqual(paper, before)
        del paper["toc"]["items"][0]["targetId"]
        self.assertEqual(r.validate_toc(paper), [])

    def test_old_paper_without_directory_and_legacy_location_are_supported(self):
        paper = navigation_fixture()
        toc = paper.pop("toc")
        self.assertEqual(r.validate_toc(paper), [])
        paper["readerSettings"] = {"toc": toc}
        self.assertEqual(r.validate_toc(paper), [])
        paper["readerSettings"]["toc"]["items"][0]["targetId"] = "invented-heading"
        self.assertTrue(r.validate_toc(paper))
        paper["toc"] = {"version": 1, "items": []}
        self.assertEqual(r.validate_toc(paper), [])  # Explicit paper.toc owns precedence.

    def test_invalid_versions_roles_children_and_bilingual_labels_fail(self):
        mutations = [lambda p: p.update(toc=None), lambda p: p["toc"].update(version=True), lambda p: p["toc"].update(version=2), lambda p: p["toc"].update(items={}), lambda p: p["toc"]["items"][0].update(role="guessed-heading"), lambda p: p["toc"]["items"][0].update(role=[]), lambda p: p["toc"]["items"][0].update(titleZh=" "), lambda p: p["toc"]["items"][0].update(titleEn=None), lambda p: p["toc"]["items"][0].update(children={}), lambda p: p["toc"]["items"][0].update(open=1), lambda p: p["toc"]["items"][0].update(evidence=""), lambda p: p["toc"]["items"][0].update(target="invented-alias")]
        for change in mutations:
            paper = navigation_fixture()
            change(paper)
            with self.subTest(paper=paper):
                self.assertTrue(r.validate_toc(paper))

    def test_only_existing_noncaption_block_or_usable_section_targets_are_valid(self):
        for target in ["invented-heading", "#methods", "legend", "figure-label", "page-header", "caption-only", None, "", []]:
            paper = navigation_fixture()
            paper["toc"]["items"][0]["targetId"] = target
            with self.subTest(target=target):
                self.assertTrue(any("target" in error for error in r.validate_toc(paper)))
        for target in ["methods", "method-title", "method-body"]:
            paper = navigation_fixture()
            paper["toc"]["items"][0]["targetId"] = target
            self.assertEqual(r.validate_toc(paper), [])

    def test_source_requires_target_and_empty_targetless_group_is_invalid(self):
        paper = navigation_fixture()
        del paper["toc"]["items"][0]["targetId"]
        self.assertTrue(r.validate_toc(paper))
        paper["toc"]["items"][0]["role"] = "navigation-group"
        self.assertEqual(r.validate_toc(paper), [])
        paper["toc"]["items"][0]["children"] = []
        self.assertTrue(r.validate_toc(paper))

    def test_duplicate_ids_cycles_and_excessive_depth_are_rejected(self):
        paper = navigation_fixture()
        paper["toc"]["items"][0]["children"][0]["id"] = "methods-entry"
        self.assertTrue(any("unique" in error for error in r.validate_toc(paper)))
        paper = navigation_fixture()
        root = paper["toc"]["items"][0]
        root["children"].append(root)
        self.assertTrue(any("hierarchy" in error for error in r.validate_toc(paper)))
        paper = navigation_fixture()
        current = paper["toc"]["items"][0]
        for index in range(18):
            child = toc_node("deep-" + str(index))
            current["children"] = [child]
            current = child
        self.assertTrue(any("hierarchy" in error for error in r.validate_toc(paper)))

    def test_supporting_source_blocks_must_exist_be_eligible_and_not_repeat(self):
        for source_ids in [["invented"], ["legend"], ["figure-label"], ["page-header"], ["method-title", "method-title"], [], {}, [None]]:
            paper = navigation_fixture()
            paper["toc"]["items"][0]["sourceBlockIds"] = source_ids
            with self.subTest(source_ids=source_ids):
                self.assertTrue(r.validate_toc(paper))
        paper = navigation_fixture()
        paper["toc"]["items"][0]["sourceBlockIds"] = ["method-title", "method-body"]
        self.assertEqual(r.validate_toc(paper), [])


class SettingsAndFingerprints(unittest.TestCase):
    def test_scale_schema_compatibility_is_explicit_without_rewriting(self):
        for settings in [{}, {"figureInitialScale": 2}, {"figureScaleSchema": 1, "figureInitialScale": 2}, {"figureScaleSchema": 2, "figureInitialScale": 1}, {"figureScaleSchema": 2, "figureInitialScale": 0.5}, {"figureScaleSchema": 2, "figureInitialScale": 8}, {"figureScaleSchema": 3}, {"figureScaleSchema": 3, "figureInitialScale": 1}]:
            paper = {"readerSettings": settings}
            before = copy.deepcopy(paper)
            self.assertEqual(r.validate_reader_settings(paper), [])
            self.assertEqual(paper, before)
        for settings in [None, {"figureScaleSchema": True}, {"figureScaleSchema": "2"}, {"figureScaleSchema": 4}, {"figureInitialScale": True}, {"figureInitialScale": 0.49}, {"figureInitialScale": 8.01}, {"figureInitialScale": float("nan")}]:
            self.assertTrue(r.validate_reader_settings({"readerSettings": settings}))

    def test_reading_font_size_validation_and_review_identity(self):
        for size in [14, 18, 26]:
            self.assertEqual(r.validate_reader_settings({"readerSettings": {"readingFontSize": size}}), [])
        for size in [True, 13, 27, 18.5, "18", None]:
            self.assertTrue(r.validate_reader_settings({"readerSettings": {"readingFontSize": size}}))

    def test_toc_and_explicit_journal_change_review_identity_not_canonical_text(self):
        paper = navigation_fixture()
        paper.update(pages=[], figures=[], formatting=[], inlineReferences=[], sourceEdits=[], metadata={})
        manifest = {"pages": []}
        before, content = r.review_fingerprint(paper, manifest), r.fingerprint(paper)
        for mutate in [lambda p: p["toc"]["items"][0].update(titleZh="自拟导航标签"), lambda p: p["metadata"].update(journal="Self-authored journal fixture"), lambda p: p.update(readerSettings={"toc": {"version": 1, "items": []}})]:
            changed = copy.deepcopy(paper)
            mutate(changed)
            self.assertNotEqual(r.review_fingerprint(changed, manifest), before)
            self.assertEqual(r.fingerprint(changed), content)

    def test_loaded_new_modules_invalidate_renderer_but_unloaded_status_does_not(self):
        required = {"assets/reader/article-info.css", "assets/reader/notes-state.js", "assets/reader/toc.js", "assets/reader/original-pdf.js", "assets/reader/selection-tools.js", "assets/reader/selection-tools.css", "assets/reader/reading-font.js", "assets/reader/reading-font.css", "assets/reader/article-search.js", "assets/reader/article-search.css", "assets/reader/reference-links.js", "assets/reader/reference-links.css"}
        self.assertTrue(required.issubset(set(r.RENDERER_RESOURCES)))
        self.assertNotIn("assets/reader/reader-status.js", r.RENDERER_RESOURCES)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for relative in r.RENDERER_RESOURCES:
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("self-authored " + relative)
            with patch.object(r, "ROOT", root):
                before = r.renderer_fingerprint()
                (root / "assets/reader/reader-status.js").write_text("unloaded legacy status")
                self.assertEqual(r.renderer_fingerprint(), before)
                for relative in required:
                    path = root / relative
                    original = path.read_text()
                    path.write_text(original + " changed")
                    self.assertNotEqual(r.renderer_fingerprint(), before, relative)
                    path.write_text(original)

    def test_required_browser_gates_match_real_v150_and_three_actual_regressions(self):
        source = (r.ROOT / "tests/reader-v150.cjs").read_text()
        gates = ast.literal_eval(re.search(r"const names=(\[[^\n]+\]);", source)[1])
        self.assertEqual(len(gates), 17)
        self.assertEqual(r.REQUIRED_BROWSER, set(gates) | {"storage-failure", "json-markdown-download-upload", "conflict-migration", "source-bound-bibliography-citation-targets", "bibliography-citation-keyboard-mobile-search-notes"})

    def test_current_version_matches_embedded_package_version(self):
        self.assertEqual(r.VERSION, "1.6.0")
        packager = (r.ROOT / "scripts/package.mjs").read_text()
        embedded_version = re.search(r"paper\.rendererVersion\s*=\s*['\"]([^'\"]+)['\"]", packager)[1]
        self.assertEqual(embedded_version, r.VERSION)

    def test_schema_three_keeps_legacy_metadata_and_bounded_reading_font(self):
        schema = json.loads((r.ROOT / "schemas/paper.schema.json").read_text())
        settings = schema["properties"]["readerSettings"]["properties"]
        self.assertEqual(settings["figureScaleSchema"]["enum"], [1, 2, 3])
        self.assertIn("contain", settings["figureScaleSchema"]["description"])
        self.assertEqual(set(settings), {"exportFilenameTemplate", "generatedDate", "figureInitialScale", "columnLayout", "figureScaleSchema", "toc", "readingFontSize"})
        self.assertNotIn("figureScaleSchema", schema["properties"]["readerSettings"].get("required", []))
        paper = {"readerSettings": {"figureScaleSchema": 2, "figureInitialScale": 8}}
        before = copy.deepcopy(paper)
        self.assertEqual(r.validate_reader_settings(paper), [])
        self.assertEqual(paper, before)

    def test_notes_v1_extensions_remain_optional_and_identity_is_typed(self):
        notes = json.loads((r.ROOT / "schemas/notes.schema.json").read_text())
        self.assertNotIn("snapshotId", notes["required"])
        self.assertNotIn("embeddedSnapshots", notes["required"])
        self.assertEqual(notes["properties"]["snapshotId"]["type"], "string")
        self.assertEqual(notes["properties"]["embeddedSnapshots"]["items"]["type"], "string")
        annotation = notes["properties"]["annotations"]["items"]
        self.assertNotIn("sourceDocumentId", annotation["required"])
        self.assertEqual(annotation["properties"]["sourceDocumentId"]["type"], "string")


class ValidatedV130State(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        (self.work / "source.pdf").write_bytes(b"Self-authored contract fixture, not a scientific PDF")
        (self.work / "page.png").write_bytes(b"Self-authored contract image fixture")
        source_hash = r.sha((self.work / "source.pdf").read_bytes())
        self.manifest = {"schemaVersion": 1, "documentId": "v130-contract", "sourceSha256": source_hash, "pages": [{"pageId": "p1", "glyphs": [{"text": "A"}]}]}
        self.paper = {"schemaVersion": 1, "documentId": "v130-contract", "sourceSha256": source_hash, "metadata": {"journal": "Self-authored journal"}, "rendererVersion": "1.3.0", "pages": [{"pageId": "p1", "assetRef": "page.png"}], "sections": [{"sectionId": "methods", "blockIds": ["method-title"]}], "blocks": [{"blockId": "method-title", "order": 0, "kind": "heading", "en": "A", "zh": "甲", "enHash": r.textsha("A"), "zhHash": r.textsha("甲"), "translationStatus": "reviewed", "sourceSpans": [{"pageId": "p1", "glyphStart": 0, "glyphEnd": 1}]}], "figures": [], "formatting": [], "inlineReferences": [], "sourceEdits": [], "idMap": [], "issues": [], "toc": {"version": 1, "items": [toc_node()]}, "reviewScopes": {"fullScientificReview": {"status": "not-performed"}}}
        self.paper["contentFingerprint"] = r.fingerprint(self.paper)
        r.write(self.work / "paper.json", self.paper)
        r.write(self.work / "source-manifest.json", self.manifest)
        r.write(self.work / "review.json", {"sourceSha256": source_hash, "contentFingerprint": self.paper["contentFingerprint"], "reviewFingerprint": r.review_fingerprint(self.paper, self.manifest), "pages": [{"status": "pass"}], "blocks": [{"status": "pass"}], "figures": []})

    def tearDown(self):
        self.tmp.cleanup()

    def test_main_validation_enforces_toc_and_journal_contract_without_changing_input(self):
        before = (self.work / "paper.json").read_bytes()
        self.assertEqual(r.validate(self.work)["content"]["errors"], [])
        self.assertEqual((self.work / "paper.json").read_bytes(), before)
        self.paper["toc"]["items"][0]["targetId"] = "fabricated"
        self.paper["metadata"]["journal"] = {"not": "text"}
        r.write(self.work / "paper.json", self.paper)
        errors = r.validate(self.work)["content"]["errors"]
        self.assertTrue(any("toc target" in error for error in errors))
        self.assertIn("metadata.journal must be text", errors)

    def test_old_browser_pass_cannot_survive_missing_current_gate_evidence(self):
        qa = r.validate(self.work)
        qa["browser"] = {"status": "pass", "checks": [{"name": "language", "status": "pass", "evidence": "Self-authored stale record"}]}
        r.write(self.work / "qa-report.json", qa)
        result = r.validate(self.work)
        self.assertEqual(result["browser"]["status"], "blocked")
        self.assertEqual(set(result["browser"]["missing"]), r.REQUIRED_BROWSER)
        self.assertEqual(result["reviewScopes"]["fullScientificReview"]["status"], "not-performed")
        self.assertEqual(result["overall"]["status"], "partial")

    def test_missing_or_unevidenced_current_gate_is_never_filled_with_pass(self):
        qa = r.validate(self.work)
        checks = [{"name": name, "status": "pass", "evidence": "Self-authored state fixture"} for name in sorted(r.REQUIRED_BROWSER)]
        missing = checks[0]["name"]
        checks[0].pop("evidence")
        qa["browser"] = {"status": "pass", "checks": checks}
        r.write(self.work / "qa-report.json", qa)
        result = r.validate(self.work)
        self.assertEqual(result["browser"]["missing"], [missing])
        self.assertEqual(result["browser"]["status"], "blocked")
        evidence = self.work / "browser.json"
        r.write(evidence, {"checks": checks})
        with self.assertRaises(ValueError):
            r.record_browser(self.work, evidence)

    def test_native_pdf_jump_gate_must_have_its_own_actual_evidence(self):
        qa = r.validate(self.work)
        native_gate = "source-button-native-pdf-page-jumps"
        checks = [{"name": name, "status": "pass", "evidence": "Self-authored gate-state fixture"} for name in sorted(r.REQUIRED_BROWSER - {native_gate})]
        qa["browser"] = {"status": "pass", "checks": checks}
        r.write(self.work / "qa-report.json", qa)
        result = r.validate(self.work)
        self.assertEqual(result["browser"]["status"], "blocked")
        self.assertEqual(result["browser"]["missing"], [native_gate])
        self.assertEqual(result["reviewScopes"]["fullScientificReview"]["status"], "not-performed")
        evidence = self.work / "without-native-pdf.json"
        r.write(evidence, {"checks": checks})
        accepted = r.record_browser(self.work, evidence)
        self.assertEqual(accepted["browser"]["status"], "blocked")
        self.assertEqual(accepted["browser"]["missing"], [native_gate])


if __name__ == "__main__":
    unittest.main()
