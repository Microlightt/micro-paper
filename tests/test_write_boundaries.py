"""Actual extractor/Node-packager write-boundary regressions, synthetic only.

Run with the installed extraction runtime:
  python3.12 -m unittest discover -s tests -p test_write_boundaries.py -v

The tiny PDF is generated here. These tests make no source-review, translation,
scientific-quality, browser, or cold-benchmark claims.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reportlab.pdfgen import canvas

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
import reader
from pipeline_common import work_lock

LOCK = ".micro-paper-write.lock"
TXN = ".translation-transaction"
PARENT_LOCK_ENV = "MICRO_PAPER_PARENT_LOCK_TOKEN"
PACKAGE = SKILL / "scripts" / "package.mjs"
NODE = shutil.which("node")


def make_source(path):
    source = canvas.Canvas(str(path), pagesize=(300, 240), invariant=1)
    source.setTitle("Self-authored write-boundary development fixture")
    for text in ("Self-authored interface fixture.", "Another synthetic interface paragraph."):
        source.setFont("Times-Roman", 11)
        source.drawString(22, 200, text)
        source.showPage()
    source.save()


def file_state(work):
    """Compare actual existing bytes, including lock/transaction metadata."""
    return {str(path.relative_to(work)): path.read_bytes()
            for path in sorted(work.rglob("*")) if path.is_file()}


class WriteBoundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise RuntimeError("Node.js is required for the real packager integration tests")
        cls.shared = tempfile.TemporaryDirectory(prefix="micro-paper-boundary-source-")
        cls.shared_root = Path(cls.shared.name)
        cls.source = cls.shared_root / "authored.pdf"
        make_source(cls.source)
        cls.template = cls.shared_root / "template"
        reader.extract(cls.source, cls.template)
        reader.validate(cls.template)

    @classmethod
    def tearDownClass(cls):
        cls.shared.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="micro-paper-boundary-test-")
        self.root = Path(self.temporary.name)
        self.work = self.fresh("work")

    def tearDown(self):
        self.temporary.cleanup()

    def fresh(self, name):
        target = self.root / name
        shutil.copytree(self.template, target)
        return target

    def node(self, work=None, *, token=None):
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        env.pop(PARENT_LOCK_ENV, None)
        if token is not None:
            env[PARENT_LOCK_ENV] = token
        return subprocess.run([NODE, str(PACKAGE), str(work or self.work), "--date", "2026-10-15"],
                              env=env, capture_output=True, text=True, timeout=20)

    def assert_rejected(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)

    def legacy_response(self, work):
        prepared = reader.prepare(work, 10000)
        self.assertEqual(len(prepared["batches"]), 1)
        batch = reader.read(prepared["batches"][0])
        response = work / "legacy-response.json"
        reader.write(response, {"batchId": batch["batchId"], "translations": [
            {"blockId": block["blockId"], "enHash": block["enHash"], "zh": "自写界面测试段落。",
             "formatting": [], "issues": [], "invariantDecisions": {}} for block in batch["blocks"]]})
        return response

    def test_legacy_prepare_and_accept_refuse_each_immutable_pipeline_marker_without_writes(self):
        for marker in ("structure-approval.json", "translation-jobs", "translation-receipts.json"):
            for action in ("prepare", "accept"):
                with self.subTest(marker=marker, action=action):
                    work = self.fresh(marker.replace(".", "-") + "-" + action)
                    response = self.legacy_response(work)
                    if marker == "translation-jobs":
                        (work / marker).mkdir()
                        (work / marker / "sentinel").write_text("immutable job", encoding="utf-8")
                    else:
                        reader.write(work / marker, {"synthetic": True, "marker": marker})
                    before = file_state(work)
                    with self.assertRaisesRegex(ValueError, "immutable translation jobs"):
                        if action == "prepare":
                            reader.prepare(work, 10000)
                        else:
                            reader.accept_translation(work, response)
                    self.assertEqual(file_state(work), before)
                    self.assertFalse((work / LOCK).exists())

    def test_unmarked_legacy_work_remains_usable(self):
        before = reader.read(self.work / "paper.json")
        response = self.legacy_response(self.work)
        result = reader.accept_translation(self.work, response)
        after = reader.read(self.work / "paper.json")
        self.assertEqual(result["status"], "merged-await-source-review")
        self.assertEqual([block["en"] for block in after["blocks"]], [block["en"] for block in before["blocks"]])
        self.assertTrue(all(block["translationStatus"] == "translated" for block in after["blocks"]))
        self.assertFalse((self.work / LOCK).exists())

    def test_extract_holds_one_writer_lock_from_dependency_entry_through_final_freeze(self):
        work = self.root / "new-extraction"
        original_dependencies, original_freeze = reader.dependencies, reader.freeze
        observed = []

        def probe(phase):
            owner_path = work / LOCK / "owner.json"
            owner = reader.read(owner_path)
            self.assertEqual(owner["operation"], "extract")
            self.assertEqual(owner["pid"], os.getpid())
            self.assertEqual(owner["hostname"], socket.gethostname())
            before = file_state(work)
            result = self.node(work)
            self.assert_rejected(result, "writer lock is held")
            self.assertEqual(file_state(work), before)
            observed.append((phase, owner["token"]))

        def dependencies():
            probe("before-pdf-read")
            return original_dependencies()

        def freeze(path, *args, **kwargs):
            probe("before-final-freeze")
            value = original_freeze(path, *args, **kwargs)
            probe("after-final-freeze")
            return value

        with patch.object(reader, "dependencies", dependencies), patch.object(reader, "freeze", freeze):
            result = reader.extract(self.source, work)
        self.assertEqual(result["pages"], 2)
        self.assertEqual([phase for phase, _ in observed], ["before-pdf-read", "before-final-freeze", "after-final-freeze"])
        self.assertEqual(len({token for _, token in observed}), 1)
        self.assertEqual((work / "source.pdf").read_bytes(), self.source.read_bytes())
        self.assertFalse((work / LOCK).exists())

    def test_extract_accepts_existing_work_source_pdf_without_samefile_copy(self):
        work = self.root / "existing-source"
        work.mkdir()
        pdf = work / "source.pdf"
        pdf.write_bytes(self.source.read_bytes())
        before = pdf.read_bytes()
        result = reader.extract(pdf, work)
        self.assertEqual(result["pages"], 2)
        self.assertEqual(pdf.read_bytes(), before)
        self.assertEqual(reader.read(work / "paper.json")["sourceSha256"], reader.sha(before))
        self.assertTrue((work / "pages" / "p2.png").is_file())
        state = file_state(work)
        self.assertEqual(reader.extract(pdf, work, resume=True)["status"], "resumed")
        self.assertEqual(file_state(work), state)
        self.assertFalse((work / LOCK).exists())

    def test_extract_refuses_pending_transaction_before_source_read_and_preserves_it(self):
        work = self.root / "pending-extraction"
        (work / TXN).mkdir(parents=True)
        (work / TXN / "state.json").write_text('{"synthetic":"pending"}', encoding="utf-8")
        before = file_state(work)
        # Missing source proves that the transaction guard is reached first.
        with self.assertRaisesRegex(ValueError, "Unfinished translation transaction"):
            reader.extract(self.root / "does-not-exist.pdf", work)
        self.assertEqual(file_state(work), before)
        self.assertFalse((work / LOCK).exists())

    def test_direct_node_refuses_live_writer_without_removing_or_changing_its_lock(self):
        with work_lock(self.work, "synthetic-active-writer"):
            before = file_state(self.work)
            result = self.node()
            self.assert_rejected(result, "writer lock is held")
            self.assertEqual(file_state(self.work), before)
            self.assertTrue((self.work / LOCK / "owner.json").exists())
            self.assertFalse((self.work / "reader.html").exists())
        self.assertFalse((self.work / LOCK).exists())

    def test_direct_node_refuses_pending_transaction_and_removes_only_its_own_lock(self):
        (self.work / TXN).mkdir()
        (self.work / TXN / "journal.json").write_text('{"synthetic":"preserve"}', encoding="utf-8")
        before = file_state(self.work)
        result = self.node()
        self.assert_rejected(result, "Unfinished translation transaction")
        self.assertEqual(file_state(self.work), before)
        self.assertFalse((self.work / LOCK).exists())
        self.assertFalse((self.work / "reader.html").exists())

    def test_direct_node_cleans_its_lock_on_early_json_and_late_asset_failures(self):
        for phase in ("invalid-paper-json", "missing-source-asset"):
            with self.subTest(phase=phase):
                work = self.fresh(phase)
                if phase == "invalid-paper-json":
                    (work / "paper.json").write_text("not JSON", encoding="utf-8")
                else:
                    (work / "source.pdf").unlink()
                before = file_state(work)
                result = self.node(work)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SyntaxError" if phase == "invalid-paper-json" else "ENOENT", result.stderr)
                self.assertEqual(file_state(work), before)
                self.assertFalse((work / LOCK).exists())
                self.assertFalse((work / "reader.html").exists())

    def test_direct_node_rejects_wrong_parent_token_and_preserves_owner(self):
        with work_lock(self.work, "synthetic-parent"):
            before = file_state(self.work)
            result = self.node(token="wrong-parent-token")
            self.assert_rejected(result, "Invalid parent writer lock")
            self.assertEqual(file_state(self.work), before)
            self.assertFalse((self.work / "reader.html").exists())
        self.assertFalse((self.work / LOCK).exists())

    def test_reader_build_borrows_actual_parent_lock_for_real_node_child(self):
        real_run = subprocess.run
        observations = []

        def run(command, *args, **kwargs):
            self.assertEqual(command[:2], [NODE, str(PACKAGE)])
            owner_path = self.work / LOCK / "owner.json"
            before = owner_path.read_bytes()
            owner = json.loads(before)
            self.assertEqual(owner["pid"], os.getpid())
            self.assertEqual(owner["operation"], "build")
            self.assertEqual(kwargs["env"][PARENT_LOCK_ENV], owner["token"])
            result = real_run(command, *args, **kwargs)
            self.assertEqual(owner_path.read_bytes(), before, "Child must preserve its live parent's lock")
            self.assertTrue((self.work / LOCK / "borrowers").is_dir())
            self.assertEqual(list((self.work / LOCK / "borrowers").iterdir()), [], "Completed child must unregister its marker")
            observations.append(json.loads(result.stdout))
            return result

        paper_before = (self.work / "paper.json").read_bytes()
        with patch.object(reader.subprocess, "run", run):
            result = reader.build(self.work, draft=True, generated_date="2026-10-15")
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0]["status"], "packaged")
        self.assertEqual(result["status"], "draft")
        self.assertTrue(Path(result["reader"]).is_file())
        self.assertEqual((self.work / "paper.json").read_bytes(), paper_before)
        self.assertFalse((self.work / LOCK).exists())

    def test_reader_build_failure_releases_parent_lock_and_child_registration(self):
        paper = reader.read(self.work / "paper.json")
        paper["pages"][0]["assetRef"] = "pages/missing.png"
        reader.write(self.work / "paper.json", paper)
        reader.freeze(self.work)
        before = (self.work / "paper.json").read_bytes()
        with self.assertRaises(subprocess.CalledProcessError) as error:
            reader.build(self.work, draft=True)
        self.assertIn("ENOENT", error.exception.stderr)
        self.assertEqual((self.work / "paper.json").read_bytes(), before)
        self.assertFalse((self.work / LOCK).exists())
        self.assertFalse((self.work / "reader.html").exists())

    def test_real_packager_preserves_literal_slots_and_replacement_metacharacters_in_data(self):
        template = (SKILL / "assets" / "reader" / "index.html").read_text(encoding="utf-8")
        slots = re.findall(r"__[A-Z][A-Z_]*__", template)
        self.assertGreater(len(slots), 10)
        literal = "Self-authored literal data: " + " ".join(slots) + " __UNKNOWN_SLOT__ $& $` $' </script> \u2028 \u2029"
        paper = reader.read(self.work / "paper.json")
        paper["metadata"]["titleEn"] = literal
        paper["blocks"][0]["en"] = literal
        paper["blocks"][0]["zh"] = "自写字面量 " + literal
        paper["blocks"][0]["enHash"] = reader.textsha(paper["blocks"][0]["en"])
        paper["blocks"][0]["zhHash"] = reader.textsha(paper["blocks"][0]["zh"])
        reader.write(self.work / "paper.json", paper)
        before = file_state(self.work)
        result = self.node()
        self.assertEqual(result.returncode, 0, result.stderr)
        packed = json.loads(result.stdout)
        html = Path(packed["output"]).read_text(encoding="utf-8")
        match = re.search(r'<script\b[^>]*\bid=["\']paper-data["\'][^>]*>([\s\S]*?)</script>', html)
        self.assertIsNotNone(match)
        embedded = json.loads(match[1])
        self.assertEqual(embedded["metadata"]["titleEn"], literal)
        self.assertEqual(embedded["blocks"][0], paper["blocks"][0])
        self.assertNotIn("</script>", match[1], "Canonical data cannot prematurely terminate its JSON script")
        self.assertNotIn("\u2028", match[1])
        self.assertNotIn("\u2029", match[1])
        self.assertIn("MicroPaperReferenceLinks", html)
        self.assertTrue(all((self.work / name).read_bytes() == data for name, data in before.items()))
        self.assertFalse((self.work / LOCK).exists())


if __name__ == "__main__":
    unittest.main()
