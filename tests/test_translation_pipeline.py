"""Synthetic-only translation jobs, CLI acceptance and real process contention."""
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "translation_pipeline.py"
sys.path.insert(0, str(SCRIPT.parent))
import translation_pipeline as pipeline


class TranslationPipeline(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.work = Path(self.temporary.name).resolve()
        self.env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        source = b"%PDF-1.0\nSynthetic identity fixture; no published article.\n"
        (self.work / "source.pdf").write_bytes(source)
        self.paper = {
            "schemaVersion": 1, "documentId": "synthetic-translation", "sourceSha256": pipeline.bytes_hash(source),
            "metadata": {"titleEn": "Synthetic fixture", "titleZh": "", "authors": []},
            "pages": [{"pageId": "p1", "number": 1, "width": 100, "height": 100, "assetRef": "pages/p1.png"}],
            "sections": [{"sectionId": "main", "titleEn": "Synthetic", "titleZh": "", "blockIds": ["body", "caption"]}],
            "blocks": [], "formatting": [], "inlineReferences": [], "idMap": [], "sourceEdits": [],
            "figures": [{"figureId": "main:1", "scope": "main", "number": 1, "captionBlockIds": ["caption"], "panelLabels": ["a"]}]
        }
        for index, (bid, kind, en) in enumerate([
            ("body", "body", "Fig. 1a shows 2 cells."),
            ("caption", "caption", "Fig. 1a | Cells show RNA at 5 mg.")
        ]):
            self.paper["blocks"].append({"blockId": bid, "order": index, "kind": kind, "en": en, "zh": "",
                                          "enHash": pipeline.reader.textsha(en), "zhHash": pipeline.reader.textsha(""),
                                          "translationStatus": "pending", "sourceSpans": [{"pageId": "p1", "glyphStart": index, "glyphEnd": index + 1, "bbox": [0, index, 10, index + 1]}]})
        pipeline.write(self.work / "paper.json", self.paper)
        pipeline.write(self.work / "source-manifest.json", {"schemaVersion": 1, "documentId": self.paper["documentId"], "sourceSha256": self.paper["sourceSha256"], "pages": [], "coverage": []})
        pipeline.write(self.work / "glossary.json", {"cell": "细胞", "RNA": "RNA"})
        pipeline.reader.freeze(self.work)
        self.paper = pipeline.read(self.work / "paper.json")
        self.approve()

    def tearDown(self):
        self.temporary.cleanup()

    def approve(self):
        paper = pipeline.read(self.work / "paper.json")
        pipeline.write(self.work / "structure-approval.json", {"schemaVersion": 1, "status": "approved", "sourceSha256": paper["sourceSha256"], "structureFingerprint": pipeline.structure_fingerprint(paper), "evidence": ["Synthetic fixture approval; not a scientific source audit."]})

    def cli(self, *arguments, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, arguments)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if success else 2, result.stdout + result.stderr)
        return json.loads(result.stdout if success else result.stderr)

    def two_batches(self):
        paper, _, glossary, _, structure = pipeline.snapshot(self.work)
        budget = max(len(pipeline.canonical(pipeline.envelope(pipeline.payload_for(paper, glossary, structure, [block["blockId"]])))) + 1 for block in paper["blocks"])
        result = self.cli("prepare", self.work, "--max-bytes", budget)
        self.assertEqual(len(result["tasks"]), 2)
        self.job = result["job"]
        self.responses = []
        translations = {"body": "图 1a 显示 2 个细胞。", "caption": "图 1a | 细胞在 5 mg 条件下显示 RNA。"}
        for index, task in enumerate(result["tasks"]):
            batch = pipeline.read(task["batch"])
            response = copy.deepcopy(task["responseEnvelope"])
            response["translations"] = [{"blockId": target["blockId"], "enHash": target["enHash"], "zh": translations[target["blockId"]], "formatting": [], "issues": [], "invariantDecisions": {}} for target in batch["payload"]["targets"]]
            path = self.work / f"independent-response-{index}.json"
            pipeline.write(path, response)
            self.responses.append(path)
        return result, budget

    def args(self, command="accept-many"):
        args = [command, str(self.work), "--job", self.job]
        for response in self.responses:
            args += ["--response", str(response)]
        return args

    def state(self):
        return {name: (self.work / name).read_bytes() if (self.work / name).exists() else None for name in ["paper.json", "source-manifest.json", pipeline.RECEIPTS]}

    def assert_blocked_unchanged(self):
        before = self.state()
        self.cli(*self.args(), success=False)
        self.assertEqual(self.state(), before)
        self.assertFalse((self.work / pipeline.LOCK).exists())
        self.assertFalse((self.work / pipeline.TXN).exists())

    def test_full_cli_immutable_context_budget_dry_run_atomic_accept_and_receipts(self):
        result, budget = self.two_batches()
        for task in result["tasks"]:
            batch = pipeline.read(task["batch"])
            self.assertLessEqual(Path(task["batch"]).stat().st_size, budget)
            self.assertEqual(len(batch["payload"]["textPool"]), 2)
            self.assertEqual(len({item["blockId"] for item in batch["payload"]["textPool"]}), 2)
            self.assertEqual(batch["payloadHash"], pipeline.digest(batch["payload"]))
        immutable = {path.name: path.read_bytes() for path in Path(self.job).iterdir()}
        repeated = self.cli("prepare", self.work, "--max-bytes", budget)
        self.assertEqual(repeated["jobId"], result["jobId"])
        self.assertEqual(immutable, {path.name: path.read_bytes() for path in Path(self.job).iterdir()})
        before = {str(path.relative_to(self.work)): path.read_bytes() for path in self.work.rglob("*") if path.is_file()}
        self.assertEqual(self.cli(*self.args("validate-many"))["status"], "validated-no-writes")
        self.assertEqual(before, {str(path.relative_to(self.work)): path.read_bytes() for path in self.work.rglob("*") if path.is_file()})
        accepted = self.cli(*self.args())
        self.assertEqual(accepted["freezeCount"], 1)
        self.assertEqual(accepted["newBatches"], 2)
        current = pipeline.read(self.work / "paper.json")
        self.assertTrue(all(b["translationStatus"] == "translated" for b in current["blocks"]))
        self.assertEqual(pipeline.structure_fingerprint(current), pipeline.structure_fingerprint(self.paper))
        after = self.state()
        self.assertEqual(self.cli(*self.args())["status"], "already-accepted")
        self.assertEqual(after, self.state())
        self.assertEqual(self.cli("prepare", self.work)["status"], "nothing-to-translate")

    def test_approval_and_complete_paragraph_budget_required(self):
        self.cli("prepare", self.work, "--max-bytes", 100, success=False)
        self.assertFalse((self.work / "translation-jobs").exists())
        approval = pipeline.read(self.work / "structure-approval.json")
        approval["status"] = "pending"
        pipeline.write(self.work / "structure-approval.json", approval)
        self.cli("prepare", self.work, success=False)
        self.assertFalse((self.work / "translation-jobs").exists())

    def test_status_queues_never_silently_retranslate(self):
        self.two_batches()
        response = pipeline.read(self.responses[0])
        response["translations"][0]["issues"] = ["Synthetic issue needing human review"]
        pipeline.write(self.responses[0], response)
        self.cli(*self.args())
        report = self.cli("prepare", self.work)
        self.assertEqual(len(report["queues"]["needs-review"]), 1)
        self.assertEqual(len(report["queues"]["translated"]), 1)
        self.cli("prepare", self.work, "--queue", "needs-review", success=False)
        retried = self.cli("prepare", self.work, "--queue", "needs-review", "--retranslate")
        batch = pipeline.read(retried["tasks"][0]["batch"])
        self.assertEqual(len(batch["payload"]["targets"]), 1)

    def test_inconsistent_status_or_chinese_hash_cannot_skip_required_work(self):
        self.two_batches()
        original = pipeline.read(self.work / "paper.json")
        cases = [
            ({"translationStatus": "original-only"}, "original-only"),
            ({"translationStatus": "translated"}, "nonblank"),
            ({"translationStatus": "needs-review"}, "nonblank"),
            ({"translationStatus": "reviewed", "zh": " \n", "zhHash": pipeline.reader.textsha(" \n")}, "nonblank"),
            ({"zhHash": "0" * 64}, "Chinese hash"),
        ]
        for changes, message in cases:
            with self.subTest(changes=changes):
                paper = copy.deepcopy(original)
                paper["blocks"][0].update(changes)
                pipeline.write(self.work / "paper.json", paper)
                before = self.state()
                self.assertIn(message, self.cli("prepare", self.work, success=False)["error"])
                self.assertEqual(before, self.state())
                self.assert_blocked_unchanged()

    def test_malformed_duplicate_missing_and_numeric_responses_never_partially_write(self):
        self.two_batches()
        saved = [path.read_bytes() for path in self.responses]
        mutations = [
            lambda value: value["translations"].clear(),
            lambda value: value["translations"].append(copy.deepcopy(value["translations"][0])),
            lambda value: value["translations"][0].update(enHash="0" * 64),
            lambda value: value["translations"][0].update(zh="图 1a | 细胞在 99 mg 条件下显示 RNA。"),
            lambda value: value.update(payloadHash="0" * 64),
            lambda value: value["translations"][0].update(formatting=[{"start": 0, "end": 1, "kind": "italic", "sourceEvidence": "test", "blockId": "body"}]),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                value = json.loads(saved[1])
                mutation(value)
                pipeline.write(self.responses[1], value)
                self.assert_blocked_unchanged()
        for path, value in zip(self.responses, saved):
            path.write_bytes(value)
        duplicate_args = self.args() + ["--response", str(self.responses[0])]
        self.cli(*duplicate_args, success=False)
        self.responses[1].write_text('{"batchId":"one","batchId":"two"}', encoding="utf-8")
        self.assert_blocked_unchanged()

    def test_utf16_and_strict_figure_signature_even_with_numeric_explanation(self):
        self.two_batches()
        original = pipeline.read(self.responses[0])
        value = copy.deepcopy(original)
        value["translations"][0]["zh"] = "🧬图 1a 显示 2 个细胞。"
        value["translations"][0]["formatting"] = [{"start": 0, "end": 1, "kind": "italic", "sourceEvidence": "synthetic"}]
        pipeline.write(self.responses[0], value)
        self.assert_blocked_unchanged()
        value["translations"][0]["formatting"][0]["end"] = 2
        pipeline.write(self.responses[0], value)
        self.cli(*self.args("validate-many"))
        value = copy.deepcopy(original)
        value["translations"][0].update(zh="图 2a 显示 2 个细胞。", invariantDecisions={"1": "Synthetic attempted numeric override", "2": "Synthetic attempted numeric override"})
        pipeline.write(self.responses[0], value)
        self.assert_blocked_unchanged()

    def test_stale_glossary_context_and_conflicting_current_translation(self):
        self.two_batches()
        glossary = (self.work / "glossary.json").read_bytes()
        pipeline.write(self.work / "glossary.json", {"cell": "不同术语"})
        self.assert_blocked_unchanged()
        (self.work / "glossary.json").write_bytes(glossary)
        paper = pipeline.read(self.work / "paper.json")
        paper["blocks"][0]["zh"] = "另一位编者的译文"
        paper["blocks"][0]["zhHash"] = pipeline.reader.textsha(paper["blocks"][0]["zh"])
        pipeline.write(self.work / "paper.json", paper)
        self.assert_blocked_unchanged()

    def test_manifest_document_identity_required_for_prepare_and_accept(self):
        self.two_batches()
        manifest = pipeline.read(self.work / "source-manifest.json")
        manifest["documentId"] = "another-document"
        pipeline.write(self.work / "source-manifest.json", manifest)
        self.assertIn("document identity", self.cli("prepare", self.work, success=False)["error"])
        self.assert_blocked_unchanged()

    def test_inputs_changed_during_staging_refuse_commit_without_partial_writes(self):
        self.two_batches()
        original_freeze = pipeline.reader.freeze
        for name in ["source.pdf", "glossary.json", "structure-approval.json"]:
            with self.subTest(name=name):
                path = self.work / name
                original = path.read_bytes()
                before = self.state()
                def mutate_after_staging(*args, **kwargs):
                    result = original_freeze(*args, **kwargs)
                    path.write_bytes(original + b"\n")
                    return result
                try:
                    with patch.object(pipeline.reader, "freeze", mutate_after_staging):
                        with self.assertRaisesRegex(ValueError, "changed state"):
                            pipeline.accept_many(self.work, self.job, self.responses)
                    self.assertEqual(before, self.state())
                    self.assertFalse((self.work / pipeline.TXN).exists())
                    self.assertFalse((self.work / pipeline.LOCK).exists())
                finally:
                    path.write_bytes(original)
        original_preflight = pipeline.preflight
        before = self.state()
        def mutate_during_dry_run(*args, **kwargs):
            plan = original_preflight(*args, **kwargs)
            with (self.work / "source.pdf").open("ab") as handle:
                handle.write(b"\n")
            return plan
        with patch.object(pipeline, "preflight", mutate_during_dry_run):
            with self.assertRaisesRegex(ValueError, "changed"):
                pipeline.dry_run(self.work, self.job, self.responses)
        self.assertEqual(before, self.state())

    def test_changed_chinese_invalidates_bibliography_pairing_preserves_unchanged_and_english(self):
        self.two_batches()
        self.cli(*self.args())
        paper = pipeline.read(self.work / "paper.json")
        records = [{"id": "en-body", "blockId": "body", "language": "en", "start": 0, "end": 1},
                   {"id": "zh-body", "blockId": "body", "language": "zh", "start": 0, "end": 1, "sourceEnCitationId": "en-body"},
                   {"id": "zh-caption", "blockId": "caption", "language": "zh", "start": 0, "end": 1}]
        paper["referenceCitations"] = copy.deepcopy(records)
        paper["referenceCitationCandidates"] = [{"id": "existing-unresolved", "status": "unresolved"}]
        pipeline.write(self.work / "paper.json", paper)
        result = self.cli("prepare", self.work, "--queue", "translated", "--retranslate")
        self.job, self.responses = result["job"], []
        for index, task in enumerate(result["tasks"]):
            response = copy.deepcopy(task["responseEnvelope"])
            response["translations"] = []
            for target in pipeline.read(task["batch"])["payload"]["targets"]:
                block = next(b for b in paper["blocks"] if b["blockId"] == target["blockId"])
                response["translations"].append({"blockId": block["blockId"], "enHash": block["enHash"],
                    "zh": "新的完整表述：" + block["zh"] if block["blockId"] == "body" else block["zh"], "formatting": [], "issues": []})
            path = self.work / f"revision-{index}.json"
            pipeline.write(path, response)
            self.responses.append(path)
        self.cli(*self.args())
        after = pipeline.read(self.work / "paper.json")
        self.assertEqual(after["referenceCitations"], [records[0], records[2]])
        self.assertEqual(after["referenceCitationCandidates"][0], paper["referenceCitationCandidates"][0])
        candidate = after["referenceCitationCandidates"][1]
        self.assertEqual(candidate["previousCitation"], records[1])
        self.assertEqual(candidate["status"], "unresolved")
        self.assertNotIn("start", candidate)
        self.assertNotEqual(candidate["previousZhHash"], candidate["currentZhHash"])
        self.assertEqual(after["blocks"][0]["translationStatus"], "needs-review")
        self.assertTrue(any("pairing" in issue for issue in after["blocks"][0]["translationIssues"]))
        self.assertEqual(after["blocks"][1]["translationStatus"], "translated")
        self.assertEqual(self.cli(*self.args())["status"], "already-accepted")

    def test_tampered_immutable_batch_and_conflicting_repeat_refused(self):
        result, _ = self.two_batches()
        batch_path = Path(result["tasks"][0]["batch"])
        original = batch_path.read_bytes()
        batch = pipeline.read(batch_path)
        batch["payload"]["textPool"][0]["en"] += " changed context"
        pipeline.write(batch_path, batch)
        self.assert_blocked_unchanged()
        batch_path.write_bytes(original)
        self.cli(*self.args())
        value = pipeline.read(self.responses[0])
        value["translations"][0]["zh"] += " 改写"
        pipeline.write(self.responses[0], value)
        self.assert_blocked_unchanged()

    def test_approved_context_change_stales_job_even_when_target_english_is_unchanged(self):
        paper = pipeline.read(self.work / "paper.json")
        context = {"blockId": "context-only", "order": 2, "kind": "figure-label", "en": "Context label", "zh": "",
                   "enHash": pipeline.reader.textsha("Context label"), "zhHash": pipeline.reader.textsha(""),
                   "translationStatus": "original-only", "exclusionReason": "Synthetic figure label",
                   "sourceSpans": [{"pageId": "p1", "glyphStart": 2, "glyphEnd": 3, "bbox": [0, 2, 10, 3]}]}
        paper["blocks"].append(context)
        pipeline.write(self.work / "paper.json", paper)
        pipeline.reader.freeze(self.work)
        self.approve()
        self.two_batches()
        paper = pipeline.read(self.work / "paper.json")
        paper["blocks"][-1]["en"] = "Changed context label"
        pipeline.write(self.work / "paper.json", paper)
        pipeline.reader.freeze(self.work)
        self.approve()
        self.assert_blocked_unchanged()

    def test_transcription_ledger_identity_guards_preparation_and_commit(self):
        # This test exercises the identity boundary only. Real page-raster and
        # visual-region proof is independently tested by source_pipeline.
        ledger_path = self.work / "source-transcription-ledger.json"
        pipeline.write(ledger_path, {"purpose": "synthetic identity guard only"})
        original_ledger = ledger_path.read_bytes()
        paper = pipeline.read(self.work / "paper.json")
        previous_fingerprint = pipeline.structure_fingerprint(paper)
        paper["sourceTranscriptionLedgerSha256"] = pipeline.bytes_hash(original_ledger)
        self.assertNotEqual(previous_fingerprint, pipeline.structure_fingerprint(paper))
        pipeline.write(self.work / "paper.json", paper)
        self.approve()
        self.assertIn("transcription ledger", self.cli("prepare", self.work, success=False)["error"])
        approval = pipeline.read(self.work / "structure-approval.json")
        approval["sourceTranscriptionLedgerSha256"] = paper["sourceTranscriptionLedgerSha256"]
        pipeline.write(self.work / "structure-approval.json", approval)
        self.two_batches()
        ledger_path.write_bytes(original_ledger + b" ")
        self.assert_blocked_unchanged()
        ledger_path.unlink()
        self.assert_blocked_unchanged()
        ledger_path.write_bytes(original_ledger)
        before = self.state()
        original_freeze = pipeline.reader.freeze
        def concurrent_ledger_change(*args, **kwargs):
            value = original_freeze(*args, **kwargs)
            ledger_path.write_bytes(original_ledger + b"\n")
            return value
        with patch.object(pipeline.reader, "freeze", concurrent_ledger_change):
            with self.assertRaisesRegex(ValueError, "Concurrent"):
                pipeline.accept_many(self.work, self.job, self.responses)
        self.assertEqual(self.state(), before)
        self.assertEqual(ledger_path.read_bytes(), original_ledger + b"\n")
        self.assertFalse((self.work / pipeline.TXN).exists())

    def test_compact_locators_do_not_duplicate_glyph_provenance_in_translation_payload(self):
        paper = pipeline.read(self.work / "paper.json")
        paper["blocks"][0]["sourceSpans"] = [{"pageId": "p1", "glyphStart": i, "glyphEnd": i + 1, "bbox": [i, 0, i + 1, 1]} for i in range(500)]
        pipeline.write(self.work / "paper.json", paper)
        pipeline.reader.freeze(self.work)
        self.approve()
        result = self.cli("prepare", self.work)
        batch = pipeline.read(result["tasks"][0]["batch"])
        body = next(item for item in batch["payload"]["textPool"] if item["blockId"] == "body")
        self.assertNotIn("sourceSpans", body)
        self.assertEqual(body["sourceLocations"], [{"pageId": "p1", "bbox": [0, 0, 500, 1]}])
        self.assertEqual(len(pipeline.read(self.work / "paper.json")["blocks"][0]["sourceSpans"]), 500)

    def test_commit_failure_rolls_back_every_file(self):
        self.two_batches()
        before = self.state()
        original = pipeline.atomic_bytes
        failed = False
        def fail_once(path, body):
            nonlocal failed
            if Path(path) == self.work / "source-manifest.json" and not failed:
                failed = True
                raise OSError("synthetic disk failure after paper write")
            return original(path, body)
        with patch.object(pipeline, "atomic_bytes", fail_once):
            with self.assertRaises(OSError):
                pipeline.accept_many(self.work, self.job, self.responses)
        self.assertTrue(failed)
        self.assertEqual(before, self.state())
        self.assertFalse((self.work / pipeline.TXN).exists())
        self.cli(*self.args())

    def test_actual_process_crash_recovery_rolls_back_partial_commit(self):
        self.two_batches()
        before = self.state()
        script = """import os,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]);import translation_pipeline as p\noriginal=p.atomic_bytes\ndef crash(path,data):\n if Path(path)==Path(sys.argv[3])/'source-manifest.json': os._exit(77)\n return original(path,data)\np.atomic_bytes=crash\nsys.exit(p.main(sys.argv[2:]))\n"""
        process = subprocess.run([sys.executable, "-c", script, str(SCRIPT.parent), *self.args()], env=self.env, capture_output=True, text=True)
        self.assertEqual(process.returncode, 77, process.stderr)
        self.assertNotEqual(before["paper.json"], (self.work / "paper.json").read_bytes())
        self.assertTrue((self.work / pipeline.LOCK).exists())
        self.assertEqual(self.cli("recover", self.work)["status"], "rolled-back-incomplete-transaction")
        self.assertEqual(before, self.state())
        self.cli(*self.args())

    def test_recovery_refuses_a_real_live_writer(self):
        script = "import sys,time;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import translation_pipeline as p\nwith p.writer_lock(Path(sys.argv[2]),'synthetic-live-writer'):\n print('READY',flush=True);time.sleep(30)\n"
        process = subprocess.Popen([sys.executable, "-c", script, str(SCRIPT.parent), str(self.work)], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "READY")
            before = self.state()
            self.cli("recover", self.work, success=False)
            self.assertEqual(before, self.state())
        finally:
            process.terminate()
            process.communicate(timeout=5)
        self.assertEqual(self.cli("recover", self.work)["status"], "no-transaction")

    def test_translation_recovery_refuses_pending_source_transaction_without_touching_either_journal(self):
        source_marker = self.work / ".source-transaction"
        pipeline.write(source_marker, {"status": "prepared", "journal": "source-journal-evidence"})
        pipeline.write(self.work / pipeline.TXN / "journal.json", {"status": "synthetic-pending-translation"})
        before = {str(path.relative_to(self.work)): path.read_bytes() for path in self.work.rglob("*") if path.is_file()}
        self.assertIn("source transaction", self.cli("recover", self.work, success=False)["error"])
        self.assertEqual(before, {str(path.relative_to(self.work)): path.read_bytes() for path in self.work.rglob("*") if path.is_file()})
        self.assertFalse((self.work / pipeline.LOCK).exists())
        dead = subprocess.Popen([sys.executable, "-c", "pass"], env=self.env)
        dead.wait(timeout=5)
        owner = {"pid": dead.pid, "hostname": pipeline.socket.gethostname(), "token": uuid.uuid4().hex}
        pipeline.write(self.work / pipeline.LOCK / "owner.json", owner)
        self.assertIn("source transaction", self.cli("recover", self.work, success=False)["error"])
        self.assertEqual(pipeline.read(self.work / pipeline.LOCK / "owner.json"), owner)
        self.assertFalse((self.work / pipeline.LOCK / "recovery-claim").exists())

    def test_recovery_refuses_live_or_unverifiable_borrowers_and_records_dead_ones(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"], env=self.env)
        dead.wait(timeout=5)
        lock = self.work / pipeline.LOCK
        lock.mkdir()
        owner = {"pid": dead.pid, "hostname": pipeline.socket.gethostname(), "token": uuid.uuid4().hex}
        pipeline.write(lock / "owner.json", owner)
        borrowers = lock / "borrowers"
        borrowers.mkdir()
        process = subprocess.Popen([sys.executable, "-c", "import time;print('READY',flush=True);time.sleep(30)"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "READY")
            marker = borrowers / f"{process.pid}.json"
            evidence = {"pid": process.pid, "parentPid": dead.pid, "hostname": pipeline.socket.gethostname(), "token": owner["token"]}
            before = self.state()
            for changes in [{}, {"hostname": "another-host"}, {"token": "wrong"}, {"pid": "malformed"}]:
                pipeline.write(marker, {**evidence, **changes})
                self.assertIn("borrow", self.cli("recover", self.work, success=False)["error"])
                self.assertEqual(self.state(), before)
                self.assertEqual(pipeline.read(lock / "owner.json"), owner)
                self.assertFalse((lock / "recovery-claim").exists())
            pipeline.write(marker, evidence)
        finally:
            process.terminate()
            process.communicate(timeout=5)
        recovered = self.cli("recover", self.work)
        self.assertEqual(recovered["status"], "no-transaction")
        self.assertEqual(recovered["verifiedDeadBorrowers"], [evidence])
        self.assertFalse(lock.exists())

    def test_borrower_registered_between_recovery_checks_prevents_lock_takeover(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"], env=self.env)
        dead.wait(timeout=5)
        lock = self.work / pipeline.LOCK
        lock.mkdir()
        owner = {"pid": dead.pid, "hostname": pipeline.socket.gethostname(), "token": uuid.uuid4().hex}
        pipeline.write(lock / "owner.json", owner)
        original = pipeline.checked_dead_borrowers
        calls = 0
        def register_after_first_check(*args):
            nonlocal calls
            result = original(*args)
            calls += 1
            if calls == 1:
                pipeline.write(lock / "borrowers" / f"{os.getpid()}.json", {"pid": os.getpid(), "parentPid": dead.pid, "hostname": pipeline.socket.gethostname(), "token": owner["token"]})
            return result
        before = self.state()
        with patch.object(pipeline, "checked_dead_borrowers", register_after_first_check):
            with self.assertRaisesRegex(ValueError, "active borrowed writer"):
                pipeline.recover(self.work)
        self.assertEqual(before, self.state())
        self.assertEqual(pipeline.read(lock / "owner.json"), owner)
        self.assertFalse((lock / "recovery-claim").exists())

    def test_crash_after_committed_marker_keeps_successful_result(self):
        self.two_batches()
        script = """import os,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]);import translation_pipeline as p\noriginal=p.shutil.rmtree\ndef crash(path,*a,**k):\n if Path(path)==Path(sys.argv[3])/p.TXN: os._exit(78)\n return original(path,*a,**k)\np.shutil.rmtree=crash\nsys.exit(p.main(sys.argv[2:]))\n"""
        process = subprocess.run([sys.executable, "-c", script, str(SCRIPT.parent), *self.args()], env=self.env, capture_output=True, text=True)
        self.assertEqual(process.returncode, 78, process.stderr)
        committed = self.state()
        self.assertEqual(self.cli("recover", self.work)["status"], "cleaned-committed-transaction")
        self.assertEqual(committed, self.state())
        self.assertEqual(self.cli(*self.args())["status"], "already-accepted")

    def test_two_real_processes_accept_two_responses_without_lost_updates(self):
        self.two_batches()
        start = self.work / "concurrency-go"
        script = """import sys,time\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]);import translation_pipeline as p\noriginal=p.reader.freeze\ndef slow(*a,**k):\n time.sleep(.25);return original(*a,**k)\np.reader.freeze=slow\nprint('READY',flush=True)\nwhile not Path(sys.argv[2]).exists():time.sleep(.01)\nsys.exit(p.main(sys.argv[3:]))\n"""
        processes = [subprocess.Popen([sys.executable, "-c", script, str(SCRIPT.parent), str(start), *self.args()], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
        try:
            for process in processes:
                self.assertEqual(process.stdout.readline().strip(), "READY")
            start.write_text("go", encoding="utf-8")
            results = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, stdout + stderr)
                results.append(json.loads(stdout))
            self.assertEqual({result["status"] for result in results}, {"accepted-await-scientific-review", "already-accepted"})
            paper = pipeline.read(self.work / "paper.json")
            self.assertTrue(all(block["zh"] and block["translationStatus"] == "translated" for block in paper["blocks"]))
            self.assertEqual(len(pipeline.read(self.work / pipeline.RECEIPTS)["batches"]), 2)
            self.assertFalse((self.work / pipeline.LOCK).exists())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    unittest.main()
