"""Synthetic fixtures only. No article cache, model request or published PDF."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_ledger.py"
sys.path.insert(0, str(SCRIPT.parent))
import run_ledger as ledger
from pipeline_common import work_lock


class SyntheticClock:
    def __init__(self):
        self.seconds = 100

    def tick(self, seconds=1):
        self.seconds += seconds

    def __call__(self):
        ns = int(self.seconds * 1e9)
        return {"utc": "synthetic-time-only", "utcNs": ns + 1_000_000_000_000,
                "monotonicNs": ns, "estimatedBootUtcNs": 1_000_000_000_000,
                "clockDomain": {"hostname": "synthetic-host", "implementation": "synthetic-monotonic"}}


class RunLedger(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "synthetic.pdf"
        self.source.write_bytes(b"%PDF-1.0\nSynthetic timing identity; not an article.\n")
        self.skill = self.root / "synthetic-skill"
        self.skill.mkdir()
        (self.skill / "SKILL.md").write_text("Synthetic skill fixture", encoding="utf-8")
        self.config = {"batchBytes": 24000, "review": "full", "browser": "desktop-mobile"}
        self.work = self.root / "run"
        self.timer = SyntheticClock()
        self.env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
        self.clock_patch = patch.object(ledger, "clock", self.timer)
        self.clock_patch.start()

    def tearDown(self):
        self.clock_patch.stop()
        self.temp.cleanup()

    def initialize(self, work=None, **kwargs):
        return ledger.init_run(work or self.work, self.source, self.skill, self.config,
                               requested_model="synthetic-request-only", requested_thinking="synthetic-level",
                               requested_service_tier="synthetic-tier", requested_max_workers=2, **kwargs)

    def artifact(self, work, name="evidence.json"):
        path = Path(work) / name
        path.write_text(json.dumps({"synthetic": True, "notScientificEvidence": True}), encoding="utf-8")
        return path

    def full_run(self, work=None, duration=2):
        work = work or self.work
        identity = self.initialize(work)
        evidence = self.artifact(work)
        for stage in ledger.STAGES:
            span = ledger.start_span(work, stage)
            self.timer.tick(duration)
            ledger.finish_span(work, span["spanId"], evidence=[evidence])
        quality = work / "quality.json"
        quality.write_text(json.dumps({"status": "passed", **{key: identity[key] for key in ("runId", "sourceSha256", "skillTreeSha256", "comparisonConfigHash", "scopeHash")},
                                     "checks": [{"stage": stage, "status": "passed", "evidenceFiles": [evidence.name]} for stage in ledger.STAGES],
                                     "syntheticTestOnly": True}), encoding="utf-8")
        ledger.complete_run(work, quality_evidence=quality)
        return ledger.report_run(work)

    def test_clean_init_binds_actual_bytes_tree_runtime_and_unknown_model(self):
        result = self.initialize()
        event = ledger.load_events(self.work)[0]["data"]
        self.assertEqual(event["source"]["sha256"], ledger.file_identity(self.source)["sha256"])
        self.assertEqual(event["source"]["bytes"], self.source.stat().st_size)
        self.assertEqual(event["skillTree"]["sha256"], ledger.skill_identity(self.skill)["sha256"])
        self.assertEqual(event["requested"]["maxWorkers"], 2)
        self.assertEqual(event["requested"]["model"], "synthetic-request-only")
        self.assertEqual(result["actualModel"]["status"], "unknown")
        self.assertIsNone(result["actualModel"]["model"])
        self.assertIn("python", event["runtime"])
        self.assertEqual(event["cleanStartAudit"]["observedFiles"], [])
        with self.assertRaisesRegex(ValueError, "only the input"):
            self.initialize()

    def test_dirty_directory_rejected_without_ledger_and_in_place_source_allowed(self):
        self.work.mkdir()
        (self.work / "cached-translation.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "only the input"):
            self.initialize()
        self.assertFalse((self.work / ledger.LEDGER).exists())
        (self.work / "cached-translation.json").unlink()
        self.source = self.work / "source.pdf"
        self.source.write_bytes(b"Synthetic source only")
        self.initialize()
        self.assertEqual(ledger.load_events(self.work)[0]["data"]["cleanStartAudit"]["observedFiles"], ["source.pdf"])

    def test_end_to_end_counts_waiting_and_gaps_without_summing_overlaps(self):
        self.initialize()
        self.timer.tick(3)
        first = ledger.start_span(self.work, "translation")
        self.timer.tick(2)
        second = ledger.start_span(self.work, "translation")
        wait = ledger.start_span(self.work, "translation", "waiting")
        self.timer.tick(4)
        ledger.finish_span(self.work, first["spanId"])
        self.timer.tick(1)
        ledger.finish_span(self.work, second["spanId"])
        ledger.finish_span(self.work, wait["spanId"])
        self.timer.tick(2)
        ledger.complete_run(self.work, "partial")
        report = ledger.report_run(self.work)
        self.assertEqual(report["elapsedSeconds"], 12)
        stats = report["stageTimings"]["translation"]
        self.assertEqual(stats["active"]["sumSpanSeconds"], 11)
        self.assertEqual(stats["active"]["unionSeconds"], 7)
        self.assertEqual(stats["active"]["maxConcurrentSpans"], 2)
        self.assertEqual(stats["waiting"]["unionSeconds"], 5)
        self.assertFalse(report["fullCompletedEligible"])

    def test_full_completion_requires_all_stages_evidence_and_no_active_spans(self):
        self.initialize()
        span = ledger.start_span(self.work, "extraction")
        with self.assertRaisesRegex(ValueError, "open span"):
            ledger.complete_run(self.work)
        self.timer.tick()
        ledger.finish_span(self.work, span["spanId"])
        with self.assertRaisesRegex(ValueError, "full completed"):
            ledger.complete_run(self.work)
        with self.assertRaisesRegex(ValueError, "already finished"):
            ledger.finish_span(self.work, span["spanId"])
        self.assertEqual(len(ledger.load_events(self.work)), 3)

    def test_full_completed_compare_and_unknown_actual_caveat(self):
        baseline = self.full_run(self.root / "baseline", duration=4)
        current = self.full_run(self.work, duration=2)
        comparison = ledger.compare_runs(current, baseline)
        self.assertTrue(current["fullCompletedEligible"])
        self.assertEqual(comparison["observedSpeedupRatio"], 2)
        self.assertFalse(comparison["actualModelEqualityVerified"])
        self.assertIn("unknown", comparison["caveat"])
        with self.assertRaisesRegex(ValueError, "immutable"):
            ledger.start_span(self.work, "browser")

    def test_comparison_blocks_partial_input_scope_config_runtime_and_same_run(self):
        baseline = self.full_run(self.root / "baseline")
        current = self.full_run(self.work)
        alterations = [lambda x: x.update(fullCompletedEligible=False),
                       lambda x: x["source"].update(sha256="other"),
                       lambda x: x.update(scopeHash="other"),
                       lambda x: x.update(comparisonConfigHash="other"),
                       lambda x: x["runtime"].update(hostname="other")]
        for alter in alterations:
            changed = copy.deepcopy(current)
            alter(changed)
            comparison = ledger.compare_runs(changed, baseline)
            self.assertEqual(comparison["status"], "blocked")
            self.assertNotIn("observedSpeedupRatio", comparison)
        self.assertIn("same-run", ledger.compare_runs(current, current)["reasons"])
        changed = copy.deepcopy(current)
        changed["skillTreeSha256"] = "deliberate-version-variable"
        self.assertEqual(ledger.compare_runs(changed, baseline)["status"], "comparable-observation")

    def test_missing_or_mutated_quality_and_source_or_skill_invalidates_completed_run(self):
        report = self.full_run()
        evidence = self.work / "evidence.json"
        original = evidence.read_bytes()
        evidence.write_text("changed", encoding="utf-8")
        self.assertFalse(ledger.report_run(self.work)["fullCompletedEligible"])
        evidence.write_bytes(original)
        self.assertTrue(ledger.report_run(self.work)["fullCompletedEligible"])
        self.source.write_bytes(b"different source")
        self.assertIn("source-changed-or-unavailable", ledger.report_run(self.work)["limitations"])
        (self.skill / "SKILL.md").write_text("changed skill", encoding="utf-8")
        self.assertIn("skill-tree-changed", ledger.report_run(self.work)["limitations"])
        self.assertEqual(report["status"], "completed")

    def test_failed_attempt_requires_explicit_successful_rework_resolution(self):
        self.initialize()
        failed = ledger.start_span(self.work, "extraction")
        self.timer.tick()
        ledger.finish_span(self.work, failed["spanId"], "failed", exit_code=9)
        retry = ledger.start_span(self.work, "extraction", "rework")
        self.timer.tick(2)
        evidence = self.artifact(self.work)
        ledger.finish_span(self.work, retry["spanId"], evidence=[evidence], resolves=[failed["spanId"]])
        report = ledger.report_run(self.work)
        self.assertNotIn("unresolved-failed-or-blocked-spans", report["limitations"])
        self.assertEqual(report["stageTimings"]["extraction"]["rework"]["unionSeconds"], 2)

    def test_clock_reboot_domain_and_wall_shift_ambiguity_is_blocked(self):
        self.initialize()
        original = self.timer()
        for changed in [dict(original, monotonicNs=1), dict(original, estimatedBootUtcNs=0),
                        dict(original, clockDomain={"hostname": "other", "implementation": "synthetic-monotonic"})]:
            with patch.object(ledger, "clock", return_value=changed):
                with self.assertRaisesRegex(ValueError, "continuity"):
                    ledger.start_span(self.work, "structure")
        self.assertEqual(len(ledger.load_events(self.work)), 1)

    def test_hash_chain_detects_mutation_missing_event_and_never_overwrites(self):
        self.initialize()
        event = self.work / ledger.LEDGER / "events" / "00000001.json"
        original = event.read_bytes()
        with work_lock(self.work, "synthetic-collision"):
            with self.assertRaises(FileExistsError):
                ledger.append_event(self.work, [], "init", {"synthetic": True})
        self.assertEqual(event.read_bytes(), original)
        body = json.loads(original)
        body["data"]["requested"]["model"] = "changed"
        event.write_text(json.dumps(body), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "hash"):
            ledger.load_events(self.work)
        event.write_bytes(original)
        ledger.start_span(self.work, "browser")
        event.unlink()
        with self.assertRaisesRegex(ValueError, "gap"):
            ledger.load_events(self.work)

    def test_quality_requires_bound_scope_each_stage_and_nonempty_existing_files(self):
        init = self.initialize()
        quality = self.work / "quality.json"
        binding = {key: init[key] for key in ("runId", "sourceSha256", "skillTreeSha256", "comparisonConfigHash", "scopeHash")}
        quality.write_text(json.dumps({"status": "passed", **binding, "checks": []}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "every stage"):
            ledger.complete_run(self.work, quality_evidence=quality)
        quality.write_text(json.dumps({"status": "passed", "scopeHash": "wrong"}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "scopeHash"):
            ledger.complete_run(self.work, quality_evidence=quality)

    def test_other_run_quality_and_unbound_stage_evidence_are_rejected(self):
        previous = self.root / "previous"
        self.full_run(previous)
        self.source.write_bytes(b"A different synthetic source PDF")
        current = self.initialize()
        evidence = self.artifact(self.work)
        for stage in ledger.STAGES:
            span = ledger.start_span(self.work, stage)
            self.timer.tick()
            ledger.finish_span(self.work, span["spanId"], evidence=[evidence])
        with self.assertRaisesRegex(ValueError, "runId"):
            ledger.complete_run(self.work, quality_evidence=previous / "quality.json")
        old_quality = ledger.read_json(previous / "quality.json")
        old_quality.update({key: current[key] for key in ("runId", "sourceSha256", "skillTreeSha256", "comparisonConfigHash", "scopeHash")})
        for check in old_quality["checks"]:
            check["evidenceFiles"] = [str(previous / "evidence.json")]
        quality = self.work / "quality.json"
        quality.write_text(json.dumps(old_quality), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "this run and stage"):
            ledger.complete_run(self.work, quality_evidence=quality)
        self.assertEqual(ledger.load_events(self.work)[-1]["type"], "finish")

    def test_real_subprocess_exit_recorded_and_concurrent_appends_serialized(self):
        # These are real local synthetic processes, not simulated model calls.
        self.clock_patch.stop()
        self.initialize()
        processes = [subprocess.Popen([sys.executable, str(SCRIPT), "start", str(self.work), "translation", "--label", str(i)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env) for i in range(5)]
        ids = []
        for process in processes:
            out, error = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, error)
            ids.append(json.loads(out)["spanId"])
        self.assertEqual(len(set(ids)), 5)
        self.assertEqual(len(ledger.load_events(self.work)), 6)
        self.assertFalse((self.work / ".micro-paper-write.lock").exists())
        processes = [subprocess.Popen([sys.executable, str(SCRIPT), "finish", str(self.work), sid],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.env) for sid in ids]
        for process in processes:
            out, error = process.communicate(timeout=20)
            self.assertEqual(process.returncode, 0, error)
        result = subprocess.run([sys.executable, str(SCRIPT), "start", str(self.work), "package", "--run", "--", sys.executable, "-c", "raise SystemExit(7)"],
                                capture_output=True, text=True, env=self.env, timeout=20)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["exitCode"], 7)
        self.assertEqual(json.loads(result.stdout)["status"], "failed")
        self.assertEqual(len(ledger.load_events(self.work)), 13)
        self.clock_patch.start()

    def test_cli_init_and_partial_report(self):
        self.clock_patch.stop()
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config), encoding="utf-8")
        commands = [["init", self.work, "--source", self.source, "--skill-root", self.skill, "--config", config],
                    ["complete", self.work, "--status", "partial"], ["report", self.work]]
        for command in commands:
            result = subprocess.run([sys.executable, str(SCRIPT), *map(str, command)], capture_output=True, text=True, env=self.env, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "partial")
        self.assertFalse(report["fullCompletedEligible"])
        self.clock_patch.start()


if __name__ == "__main__":
    unittest.main()
