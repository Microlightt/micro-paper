"""Cold, synthetic PDF tests. No real-paper JSON, crops or translations are read."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import reader
import source_pipeline as source
from pipeline_common import structure_fingerprint


class SourcePipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pdf = self.root / "synthetic.pdf"
        self.work = self.root / "work"

    def tearDown(self):
        self.temp.cleanup()

    def pdf_file(self, texts=("First source paragraph.", "Continues on another page."), graphic=False, blank=False, two_columns=False):
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        from PIL import Image
        document = canvas.Canvas(str(self.pdf), pagesize=(400, 400), invariant=1)
        for index, text in enumerate(texts):
            if not (blank and index == len(texts) - 1):
                document.setFont("Helvetica", 11); document.drawString(30, 350, text)
                if two_columns:
                    document.setFont("Helvetica-Oblique", 10); document.drawString(230, 350, "Right column text.")
                if graphic:
                    document.rect(30, 140, 150, 140, stroke=1, fill=0)
                    document.drawImage(ImageReader(Image.new("RGB", (8, 8), "red")), 210, 180, 50, 40)
                    document.setFont("Helvetica", 11); document.drawString(30, 310, "Second figure legend.")
            document.showPage()
        document.save()
        return self.pdf

    def extract(self, **kwargs):
        return source.extract_source(self.pdf, self.work, workers=kwargs.pop("workers", 1), **kwargs)

    def response(self, groups=None):
        result = source.structure_packets(self.work)
        response = source.read(result["responseTemplate"])
        paper = source.read(self.work / "paper.json")
        groups = groups if groups is not None else [[b["blockId"]] for b in paper["blocks"]]
        owner = {bid: i for i, ids in enumerate(groups) for bid in ids}
        blocks = {b["blockId"]: b for b in paper["blocks"]}
        for page in response["pages"]:
            page.update(status="pass", evidence="Synthetic original page visually defined by the test fixture.", graphics=[])
            if page["graphicRegionIds"]:
                page["graphics"] = [{"regionIds": page["graphicRegionIds"], "decision": "source-only", "evidence": "Synthetic shapes explicitly retained as source-only for this review."}]
        for boundary in response["boundaries"]:
            boundary.update(decision="same" if owner[boundary["leftBlockId"]] == owner[boundary["rightBlockId"]] else "different", evidence="Explicit synthetic boundary decision.")
        for boundary in response["internalBoundaries"]:
            boundary.update(decision="same", evidence="Explicit internal cross-page continuation review.")
        response["groups"] = [{"blockIds": ids, "kind": blocks[ids[0]]["kind"], "joiner": " ", "evidence": "Explicit source grouping.", **({"exclusionReason": blocks[ids[0]].get("exclusionReason", "Source-only fixture.")} if blocks[ids[0]]["kind"] in source.EXEMPT else {})} for ids in groups]
        response["sections"] = [{"sectionId": "source", "titleEn": "Source text", "titleZh": "原文", "blockIds": [ids[0] for ids in groups]}]
        response["evidence"] = ["Synthetic source pages and every boundary were explicitly reviewed for this test."]
        return response

    def save_response(self, response):
        path = self.root / "response.json"; source.json_write(path, response); return path

    def figure_request(self):
        paper = source.read(self.work / "paper.json")
        captions = paper["blocks"][:2]
        figures = []
        for index, block in enumerate(captions, 1):
            figures.append({"figureId": f"main:{index}", "sourcePageNumber": 1, "crop": [25 + index, 115, 185, 265], "scale": 4,
                            "reviewed": True, "sourceEvidence": "Synthetic PDF original vector rectangle boundary reviewed.", "captionBlockIds": [block["blockId"]],
                            "captionEvidence": [{"blockId": block["blockId"], "enHash": block["enHash"], "sourceSpans": copy.deepcopy(block["sourceSpans"]), "sourceEvidence": "Exact synthetic original caption glyph range reviewed."}]})
        return {"sourceSha256": paper["sourceSha256"], "paperSha256": source.sha((self.work / "paper.json").read_bytes()), "figures": figures}

    def raster_fixture(self, mixed=False, pages=2):
        """Authored raster text is recorded before canonical blocks are constructed."""
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        from PIL import Image, ImageDraw
        authored = ["Synthetic reporting page " + str(n + 1) + "." + (" α form" if mixed else "") for n in range(pages)]
        document = canvas.Canvas(str(self.pdf), pagesize=(400, 400), invariant=1)
        for number in range(pages):
            image = Image.new("RGB", (800, 800), "white")
            ImageDraw.Draw(image).text((60, 100), "Synthetic reporting page " + str(number + 1) + ".", fill="black")
            document.drawImage(ImageReader(image), 0, 0, 400, 400)
            if mixed:
                document.setFont("Symbol", 12); document.drawString(30, 300, "a")
                document.setFont("Helvetica", 12); document.drawString(50, 300, " form")
            document.showPage()
        document.save(); self.extract()
        inventory_path = self.work / "source-inventory/inventory.json"; inventory = source.read(inventory_path)
        ledger = {"schemaVersion": 1, "sourceSha256": inventory["sourceSha256"], "inventorySha256": source.file_hash(inventory_path), "independentOfPaper": True,
                  "provenance": {"input": "source.pdf", "method": "manual-page-raster-review"}, "pages": []}
        for index, page in enumerate(inventory["pages"]):
            ranges = [{"glyphStart": 0, "glyphEnd": len(page["glyphs"])}] if page["glyphs"] else []
            rid = page["pageId"] + "-authored-reporting"
            ledger["pages"].append({"pageId": page["pageId"], "rasterSha256": page["raster"]["sha256"],
                "regions": [{"regionId": rid, "bbox": [0, 0, 400, 400], "en": authored[index], "enHash": source.sha(authored[index].encode()), "sourceEvidence": "Authored synthetic full-page raster and overlay text checked against original fixture design.", "nativeGlyphRanges": ranges}],
                "review": {"status": "reviewed", "reviewer": "Synthetic fixture author", "evidence": "All four page edges and complete authored reporting text, empty background and native overlay checked.", "coverageBbox": [0, 0, 400, 400], "regionIds": [rid], "nativeGlyphRanges": ranges}})
        # Source ledger exists first and never obtains English from paper.json.
        source.json_write(self.work / "source-transcription-ledger.json", ledger)
        paper = source.read(self.work / "paper.json"); paper["blocks"] = []; paper["formatting"] = []
        for index, page in enumerate(inventory["pages"]):
            region = ledger["pages"][index]["regions"][0]
            spans = [{"pageId": page["pageId"], "glyphStart": i, "glyphEnd": i + 1, "bbox": g["bbox"]} for i, g in enumerate(page["glyphs"])]
            spans.append({"pageId": page["pageId"], "bbox": region["bbox"], "transcription": True, "sourceEvidence": region["sourceEvidence"]})
            paper["blocks"].append({"blockId": "visual-" + page["pageId"], "order": index, "kind": "reporting", "en": region["en"], "enHash": region["enHash"], "zh": "", "zhHash": source.sha(b""), "translationStatus": "pending", "sourceSpans": spans})
        paper["sections"] = [{"sectionId": "reporting", "titleEn": "Reporting", "titleZh": "", "blockIds": [b["blockId"] for b in paper["blocks"]]}]
        source.json_write(self.work / "paper.json", paper); reader.freeze(self.work)
        return ledger

    def test_actual_raster_pdf_legacy_spans_approve_and_prepare_translation(self):
        import translation_pipeline
        ledger = self.raster_fixture()
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "pass")
        ids = [b["blockId"] for b in source.read(self.work / "paper.json")["blocks"]]
        result = source.accept_structure(self.work, self.save_response(self.response([ids])), workers=1)
        paper = source.read(self.work / "paper.json"); ledger_hash = source.file_hash(self.work / "source-transcription-ledger.json")
        self.assertEqual(result["sourceTranscriptionLedgerSha256"], ledger_hash)
        self.assertEqual(paper["sourceTranscriptionLedgerSha256"], ledger_hash)
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "pass")
        spans = paper["blocks"][0]["sourceSpans"]
        self.assertEqual(spans[1]["textStart"], source.u16(ledger["pages"][0]["regions"][0]["en"]) + 1)
        self.assertTrue(translation_pipeline.prepare(self.work)["tasks"])
        ledger_bytes = (self.work / "source-transcription-ledger.json").read_bytes()
        (self.work / "source-transcription-ledger.json").unlink()
        qa = reader.validate(self.work)
        self.assertIn("Independent transcription ledger identity mismatch", str(qa))
        source.atomic(self.work / "source-transcription-ledger.json", ledger_bytes)
        self.assertNotIn("Independent transcription ledger identity mismatch", str(reader.validate(self.work)))

    def test_actual_mixed_raster_pdf_keeps_native_glyphs_and_visual_text_once(self):
        import translation_pipeline
        self.raster_fixture(mixed=True)
        original_inventory = (self.work / "source-inventory/inventory.json").read_bytes()
        original_manifest_glyphs = [p["glyphs"] for p in source.read(self.work / "source-manifest.json")["pages"]]
        self.assertGreater(len(original_manifest_glyphs[0]), 0)
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "pass")
        ids = [b["blockId"] for b in source.read(self.work / "paper.json")["blocks"]]
        source.accept_structure(self.work, self.save_response(self.response([ids])), workers=1)
        self.assertEqual((self.work / "source-inventory/inventory.json").read_bytes(), original_inventory)
        self.assertEqual([p["glyphs"] for p in source.read(self.work / "source-manifest.json")["pages"]], original_manifest_glyphs)
        self.assertTrue(translation_pipeline.prepare(self.work)["tasks"])
        paper = source.read(self.work / "paper.json"); paper["blocks"][0]["sourceSpans"].append(copy.deepcopy(paper["blocks"][0]["sourceSpans"][0]))
        self.assertEqual(source.audit_source(self.work, paper, workers=1)["status"], "fail")

    def test_transcription_missing_or_tampered_evidence_and_unproved_text_rejected(self):
        ledger = self.raster_fixture(mixed=True, pages=1)
        path = self.work / "source-transcription-ledger.json"; original = path.read_bytes(); paper = source.read(self.work / "paper.json")
        changes = [lambda l: l["pages"][0]["review"].update(evidence=""),
                   lambda l: l["pages"][0]["review"].update(coverageBbox=[0, 0, 399, 400]),
                   lambda l: l["pages"][0]["regions"].append(copy.deepcopy(l["pages"][0]["regions"][0])),
                   lambda l: l["pages"][0]["regions"][0].update(enHash="0" * 64),
                   lambda l: l["pages"][0]["regions"][0].update(bbox=[0, 0, 399, 400]),
                   lambda l: l["pages"][0]["review"].update(nativeGlyphRanges=[]),
                   lambda l: l["pages"][0].update(rasterSha256="0" * 64)]
        for change in changes:
            modified = copy.deepcopy(ledger); change(modified); source.json_write(path, modified)
            self.assertNotEqual(source.audit_source(self.work, workers=1)["status"], "pass")
        source.atomic(path, original); bad = copy.deepcopy(paper); bad["blocks"][0]["en"] += " injected"
        bad["sourceEdits"] = [{"blockId": bad["blocks"][0]["blockId"], "before": paper["blocks"][0]["en"], "after": bad["blocks"][0]["en"], "sourceEvidence": "Cannot approve independently unsupported text"}]
        self.assertEqual(source.audit_source(self.work, bad, workers=1)["status"], "fail")
        path.unlink(); self.assertNotEqual(source.audit_source(self.work, workers=1)["status"], "pass")

    def test_transcription_ledger_drift_between_packet_and_accept_is_rejected(self):
        self.raster_fixture(pages=1); response = self.response(); before = (self.work / "paper.json").read_bytes()
        path = self.work / "source-transcription-ledger.json"; value = source.read(path); value["pages"][0]["review"]["evidence"] += " changed"
        source.json_write(path, value)
        with self.assertRaisesRegex(ValueError, "transcription ledger changed"):
            source.accept_structure(self.work, self.save_response(response), workers=1)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)

    def test_parallel_extraction_matches_serial_original_glyph_semantics(self):
        self.pdf_file(two_columns=True, graphic=True)
        self.extract(workers=2)
        legacy = self.root / "legacy-synthetic"
        reader.extract(self.pdf, legacy)
        current, previous = source.read(self.work / "paper.json"), source.read(legacy / "paper.json")
        for key in ("blocks", "pages", "sections", "formatting", "inlineReferences", "sourceEdits", "idMap"):
            self.assertEqual(current[key], previous[key], key)
        self.assertEqual(source.read(self.work / "source-manifest.json")["pages"], source.read(legacy / "source-manifest.json")["pages"])
        self.assertEqual((self.work / "pages/p1.png").read_bytes(), (legacy / "pages/p1.png").read_bytes())
        inventory = source.read(self.work / "source-inventory/inventory.json")
        self.assertTrue(inventory["independentOfPaper"])
        self.assertTrue(inventory["pages"][0]["images"])
        self.assertTrue(inventory["pages"][0]["drawings"])
        self.assertIn("encodedStreamSha256", inventory["pages"][0]["images"][0])
        self.assertEqual(source.audit_source(self.work, workers=2)["status"], "pass")

    def test_inventory_is_immutable_and_worker_count_does_not_change_evidence(self):
        self.pdf_file(); self.extract()
        other = self.root / "other-inventory"
        source.create_inventory(self.pdf, other, workers=2, raster_scale=2)
        self.assertEqual((self.work / "source-inventory/inventory.json").read_bytes(), (other / "inventory.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "already exists"):
            source.create_inventory(self.pdf, other, workers=1)
        self.assertEqual((other / "pages/p1.json").stat().st_mode & 0o777, 0o444)

    def test_fresh_pdf_audit_detects_joint_paper_manifest_and_inventory_tampering(self):
        self.pdf_file(); self.extract()
        paper = source.read(self.work / "paper.json"); manifest = source.read(self.work / "source-manifest.json")
        inventory = source.read(self.work / "source-inventory/inventory.json")
        paper["blocks"][0]["en"] = "X" + paper["blocks"][0]["en"][1:]
        manifest["pages"][0]["glyphs"][0]["text"] = "X"; inventory["pages"][0]["glyphs"][0]["text"] = "X"
        source.json_write(self.work / "paper.json", paper); source.json_write(self.work / "source-manifest.json", manifest)
        source.json_write(self.work / "source-inventory/inventory.json", inventory)
        result = source.audit_source(self.work, workers=1)
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("manifest native glyph" in error for error in result["errors"]))
        self.assertTrue(any("Independent inventory differs" in error for error in result["errors"]))

    def test_duplicate_and_missing_glyph_provenance_are_rejected(self):
        self.pdf_file(); self.extract()
        paper = source.read(self.work / "paper.json")
        paper["blocks"][0]["sourceSpans"].append(copy.deepcopy(paper["blocks"][0]["sourceSpans"][0]))
        self.assertEqual(source.audit_source(self.work, paper, workers=1)["status"], "fail")
        paper = source.read(self.work / "paper.json"); paper["blocks"].pop()
        self.assertEqual(source.audit_source(self.work, paper, workers=1)["status"], "fail")

    def test_bbox_page_order_and_raster_drift_are_rejected(self):
        self.pdf_file(); self.extract(); paper = source.read(self.work / "paper.json")
        paper["blocks"][0]["sourceSpans"][0]["bbox"][0] -= 1
        self.assertEqual(source.audit_source(self.work, paper, workers=1)["status"], "fail")
        paper = source.read(self.work / "paper.json"); paper["pages"].reverse()
        self.assertEqual(source.audit_source(self.work, paper, workers=1)["status"], "fail")
        (self.work / "pages/p1.png").write_bytes(b"changed")
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "fail")

    def test_no_native_characters_remains_blocked(self):
        self.pdf_file(blank=True); self.extract()
        result = source.audit_source(self.work, workers=1)
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(any("No native characters" in value for value in result["blocked"]))
        response = self.response()
        with self.assertRaisesRegex(ValueError, "audit is not pass"):
            source.accept_structure(self.work, self.save_response(response), workers=1)

    def test_pretranslation_crosspage_merge_preserves_glyphs_format_and_ids(self):
        self.pdf_file(); self.extract()
        paper = source.read(self.work / "paper.json"); ids = [b["blockId"] for b in paper["blocks"]]
        response = self.response([ids]); result = source.accept_structure(self.work, self.save_response(response), workers=1)
        merged = source.read(self.work / "paper.json")
        self.assertEqual(result["status"], "approved"); self.assertEqual(len(merged["blocks"]), 1)
        self.assertEqual(merged["blocks"][0]["en"], " ".join(b["en"] for b in paper["blocks"]))
        self.assertEqual(merged["blocks"][0]["sourceSpans"], sum([b["sourceSpans"] for b in paper["blocks"]], []))
        self.assertEqual(len(merged["idMap"]), 2); self.assertEqual(reader.validate_id_map(merged), [])
        self.assertEqual(result["structureFingerprint"], structure_fingerprint(merged))
        self.assertFalse((self.work / ".source-transaction").exists())

    def test_missing_boundary_and_stale_response_do_not_mutate_paper(self):
        self.pdf_file(); self.extract(); response = self.response()
        before = (self.work / "paper.json").read_bytes(); response["boundaries"] = []
        with self.assertRaisesRegex(ValueError, "Every adjacency"):
            source.accept_structure(self.work, self.save_response(response), workers=1)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)
        response = self.response(); response["paperSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "stale"):
            source.accept_structure(self.work, self.save_response(response), workers=1)

    def test_reviewed_source_repairs_survive_crosspage_grouping(self):
        self.pdf_file(texts=("Alpha-", "beta.")); self.extract(); paper = source.read(self.work / "paper.json")
        first = paper["blocks"][0]; original = first["en"]; first["en"] = "Alpha"; first["enHash"] = source.sha(first["en"].encode())
        edit = {"blockId": first["blockId"], "before": original, "after": "Alpha", "reason": "Reviewed line-end word continuation", "sourceEvidence": "Synthetic original pages explicitly show one hyphenated word."}
        paper["sourceEdits"] = [edit]; source.json_write(self.work / "paper.json", paper)
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "pass")
        response = self.response([[b["blockId"] for b in paper["blocks"]]]); response["groups"][0]["joiner"] = ""
        source.accept_structure(self.work, self.save_response(response), workers=1)
        output = source.read(self.work / "paper.json")
        self.assertEqual(output["blocks"][0]["en"], "Alphabeta.")
        self.assertEqual(output["sourceEdits"][0]["originalSourceEdits"], [edit])
        self.assertEqual(source.audit_source(self.work, workers=1)["status"], "pass")

    def test_existing_internal_crosspage_boundary_cannot_hide_in_one_block(self):
        self.pdf_file(); self.extract(); ids = [b["blockId"] for b in source.read(self.work / "paper.json")["blocks"]]
        source.accept_structure(self.work, self.save_response(self.response([ids])), workers=1)
        response = self.response(); self.assertEqual(len(response["internalBoundaries"]), 1)
        response["internalBoundaries"] = []
        with self.assertRaisesRegex(ValueError, "within-block"):
            source.accept_structure(self.work, self.save_response(response), workers=1)

    def test_heading_type_barrier_cannot_be_merged_as_body(self):
        self.pdf_file(); self.extract(); paper = source.read(self.work / "paper.json")
        paper["blocks"][0]["kind"] = "heading"; source.json_write(self.work / "paper.json", paper)
        ids = [b["blockId"] for b in paper["blocks"]]; response = self.response([ids]); response["groups"][0]["kind"] = "body"
        with self.assertRaisesRegex(ValueError, "barrier"):
            source.accept_structure(self.work, self.save_response(response), workers=1)

    def test_batch_crop_renders_page_once_keeps_full_pixels_and_reviewed_ledger(self):
        self.pdf_file(texts=("First figure legend.",), graphic=True); self.extract()
        request = self.figure_request(); path = self.root / "figures.json"; source.json_write(path, request)
        result = source.batch_crop(self.work, path)
        self.assertEqual(result["renderCount"], 1); self.assertEqual(result["figures"], 2)
        import pypdfium2
        from PIL import Image
        pdf = pypdfium2.PdfDocument(str(self.pdf)); page = pdf[0]; bitmap = page.render(scale=4); full = bitmap.to_pil()
        ledger = source.read(self.work / "source-figure-ledger.json")
        for figure in ledger["figures"]:
            with Image.open(self.work / ("figures/" + figure["figureId"].replace(":", "-") + ".png")) as image:
                expected = full.crop(tuple(figure["pixelBox"]))
                self.assertEqual(image.size, expected.size); self.assertEqual(image.tobytes(), expected.tobytes()); expected.close()
            self.assertTrue(figure["captionGlyphRanges"])
        full.close(); bitmap.close(); page.close(); pdf.close()
        self.assertFalse(ledger["figureLedgerComplete"])
        response = self.response()
        for review in response["pages"]:
            if review["graphicRegionIds"]:
                review["graphics"] = [{"regionIds": review["graphicRegionIds"], "decision": "figure", "figureIds": ["main:1", "main:2"], "evidence": "Both synthetic figure sources reviewed against the original page."}]
        source.accept_structure(self.work, self.save_response(response), workers=1)
        self.assertTrue(source.read(self.work / "source-figure-ledger.json")["figureLedgerComplete"])

    def test_caption_mappings_survive_same_figure_merge_and_tamper_is_rejected(self):
        self.pdf_file(texts=("First figure legend.",), graphic=True); self.extract()
        request = self.figure_request(); first, second = request["figures"]
        first["captionBlockIds"] += second["captionBlockIds"]; first["captionEvidence"] += second["captionEvidence"]; request["figures"] = [first]
        path = self.root / "figures.json"; source.json_write(path, request); source.batch_crop(self.work, path)
        paper = source.read(self.work / "paper.json"); response = self.response([[b["blockId"] for b in paper["blocks"]]])
        for page in response["pages"]:
            page["graphics"] = [{"regionIds": page["graphicRegionIds"], "decision": "figure", "figureIds": ["main:1"], "evidence": "Original synthetic source figure explicitly reviewed."}]
        source.accept_structure(self.work, self.save_response(response), workers=1)
        ledger = source.read(self.work / "source-figure-ledger.json"); proof = ledger["figures"][0]
        self.assertEqual(len(proof["captionBlockIds"]), 1); self.assertEqual(len(proof["captionBlockMappings"]), 2)
        self.assertEqual({x["canonicalBlockId"] for x in proof["captionEvidence"]}, set(proof["captionBlockIds"]))
        source.validate_caption_ledger(self.work, source.read(self.work / "paper.json"), ledger)
        proof["captionBlockMappings"][1]["start"] -= 1
        with self.assertRaisesRegex(ValueError, "caption text changed"):
            source.validate_caption_ledger(self.work, source.read(self.work / "paper.json"), ledger)

    def test_stale_parallel_crop_task_and_commit_failure_preserve_outputs(self):
        self.pdf_file(texts=("First figure legend.",), graphic=True); self.extract(); request = self.figure_request()
        path = self.root / "figures.json"; request["paperSha256"] = "0" * 64; source.json_write(path, request)
        before = (self.work / "paper.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "Stale"):
            source.batch_crop(self.work, path)
        request = self.figure_request(); source.json_write(path, request); original_atomic = source.atomic
        def fail_ledger(destination, *args, **kwargs):
            if Path(destination) == self.work / "source-figure-ledger.json":
                raise OSError("Injected commit failure")
            return original_atomic(destination, *args, **kwargs)
        with patch.object(source, "atomic", side_effect=fail_ledger):
            with self.assertRaisesRegex(OSError, "Injected"):
                source.batch_crop(self.work, path)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)
        self.assertFalse((self.work / "figures/main-1.png").exists()); self.assertFalse((self.work / ".source-transaction").exists())

    def test_pending_source_transaction_blocks_legacy_freeze_and_packager(self):
        self.pdf_file(); self.extract(); source.json_write(self.work / ".source-transaction", {"status": "prepared", "journal": "test"})
        before = (self.work / "paper.json").read_bytes()
        with self.assertRaises(Exception):
            reader.freeze(self.work)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)
        node = os.environ.get("MICRO_PAPER_TEST_NODE") or shutil.which("node")
        if node:
            result = subprocess.run([node, str(SCRIPTS / "package.mjs"), str(self.work)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source", result.stdout + result.stderr)

    def test_pending_translation_transaction_blocks_source_mutations(self):
        self.pdf_file(); self.extract(); before = (self.work / "paper.json").read_bytes()
        source.json_write(self.work / ".translation-transaction", {"status": "recovery-required"})
        with self.assertRaises(Exception):
            source.structure_packets(self.work)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)

    def test_noncooperating_manifest_change_before_commit_is_not_overwritten(self):
        self.pdf_file(); self.extract(); response = self.response(); original_commit = source._commit
        paper_before = (self.work / "paper.json").read_bytes()
        def changed_manifest(work, changes, expected):
            manifest = source.read(work / "source-manifest.json"); manifest["concurrentSentinel"] = "preserve"
            source.json_write(work / "source-manifest.json", manifest)
            return original_commit(work, changes, expected)
        with patch.object(source, "_commit", side_effect=changed_manifest):
            with self.assertRaisesRegex(ValueError, "Concurrent source change"):
                source.accept_structure(self.work, self.save_response(response), workers=1)
        self.assertEqual((self.work / "paper.json").read_bytes(), paper_before)
        self.assertEqual(source.read(self.work / "source-manifest.json")["concurrentSentinel"], "preserve")


if __name__ == "__main__":
    unittest.main()
