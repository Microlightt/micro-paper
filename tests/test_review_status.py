"""Self-authored state fixtures; these tests do not review any scientific document."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import reader as r


class ReviewStatus(unittest.TestCase):
    def test_machine_and_browser_pass_do_not_imply_scientific_pass(self):
        passed = {"status": "pass"}
        scopes = {"paragraphRepair": {"status": "pass", "evidence": ["Synthetic repair evidence"]}, "fullScientificReview": {"status": "not-performed"}}
        self.assertEqual(r.overall_review_status(passed, passed, scopes), "partial")
        self.assertEqual(r.overall_review_status(passed, passed, {}), "partial")
        scopes["fullScientificReview"] = {"status": "pass", "evidence": "Synthetic complete-scope evidence"}
        self.assertEqual(r.overall_review_status(passed, passed, scopes), "pass")
        self.assertEqual(r.overall_review_status(passed, {"status": "blocked"}, scopes), "partial")
        self.assertEqual(r.overall_review_status({"status": "fail"}, passed, scopes), "fail")
        scopes["paragraphRepair"]["status"] = "fail"
        self.assertEqual(r.overall_review_status(passed, passed, scopes), "fail")

    def test_scope_validation_requires_explicit_status_and_evidence_for_pass(self):
        self.assertEqual(r.validate_review_scopes({}), [])
        self.assertEqual(r.validate_review_scopes({"reviewScopes": {"fullScientificReview": {"status": "not-performed"}}}), [])
        self.assertTrue(r.validate_review_scopes({"reviewScopes": {"paragraphRepair": {"status": "pass"}}}))
        self.assertTrue(r.validate_review_scopes({"reviewScopes": {"paragraphRepair": {"status": "error", "evidence": "Synthetic proof"}}}))
        self.assertTrue(r.validate_review_scopes({"reviewScopes": {"paragraphRepair": {"status": {"raw": "error"}}}}))
        self.assertTrue(r.validate_review_scopes({"reviewScopes": {"paragraphRepair": {"status": ["pending"]}}}))
        self.assertTrue(r.validate_review_scopes({"reviewScopes": {"paragraphRepair": {"status": "pass", "evidence": [""]}}}))

    def test_structured_issues_preserve_nested_objects_without_aliasing(self):
        source = [{"type": "acceptance-pending", "blockId": "synthetic-block", "detail": {"codes": [1, 2]}}, "legacy issue"]
        result = r.structured_issues(source)
        self.assertEqual(result, source)
        result[0]["detail"]["codes"].append(3)
        self.assertEqual(source[0]["detail"]["codes"], [1, 2])
        self.assertEqual(r.structured_issues([3]), [{"code": "unrecognized-issue", "detail": 3}])
        self.assertEqual(r.structured_issues({"unexpected": True}), [{"code": "invalid-issues", "detail": {"unexpected": True}}])


class ValidatedState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name)
        (self.work / "source.pdf").write_bytes(b"Self-authored state fixture, not a research PDF")
        (self.work / "page.png").write_bytes(b"State-only image fixture")
        source_hash = r.sha((self.work / "source.pdf").read_bytes())
        self.manifest = {"schemaVersion": 1, "documentId": "synthetic-state-fixture", "sourceSha256": source_hash, "pages": [{"pageId": "page-1", "glyphs": [{"text": "A"}]}]}
        self.paper = {"schemaVersion": 1, "documentId": "synthetic-state-fixture", "sourceSha256": source_hash, "rendererVersion": "1.2.0", "pages": [{"pageId": "page-1", "assetRef": "page.png"}], "sections": [{"sectionId": "section-body", "blockIds": ["body"]}], "blocks": [{"blockId": "body", "order": 0, "kind": "body", "en": "A", "zh": "甲", "enHash": r.textsha("A"), "zhHash": r.textsha("甲"), "translationStatus": "reviewed", "sourceSpans": [{"pageId": "page-1", "glyphStart": 0, "glyphEnd": 1}]}], "figures": [], "formatting": [], "inlineReferences": [], "sourceEdits": [], "idMap": [], "issues": [], "reviewScopes": {"paragraphRepair": {"status": "pass", "evidence": "Self-authored state fixture only"}, "fullScientificReview": {"status": "not-performed"}}}
        self.paper["contentFingerprint"] = r.fingerprint(self.paper)
        r.write(self.work / "paper.json", self.paper)
        r.write(self.work / "source-manifest.json", self.manifest)
        r.write(self.work / "review.json", {"sourceSha256": source_hash, "contentFingerprint": self.paper["contentFingerprint"], "reviewFingerprint": r.review_fingerprint(self.paper, self.manifest), "pages": [{"status": "pass"}], "blocks": [{"status": "pass"}], "figures": []})
        self.renderer = patch.object(r, "renderer_fingerprint", return_value="synthetic-renderer")
        self.renderer.start()

    def tearDown(self):
        self.renderer.stop()
        self.tmp.cleanup()

    def test_scopes_change_review_identity_without_changing_canonical_text(self):
        before = r.review_fingerprint(self.paper, self.manifest)
        content = r.fingerprint(self.paper)
        changed = copy.deepcopy(self.paper)
        changed["reviewScopes"]["fullScientificReview"] = {"status": "pass", "evidence": "Synthetic state change"}
        self.assertEqual(r.fingerprint(changed), content)
        self.assertNotEqual(r.review_fingerprint(changed, self.manifest), before)
        r.write(self.work / "paper.json", changed)
        qa = r.validate(self.work)
        self.assertEqual(qa["content"]["status"], "blocked")
        self.assertIn("Source review scope, figures or formatting changed", qa["content"]["blocked"])
        self.assertEqual(qa["browser"]["status"], "blocked")

    def test_validation_and_browser_acceptance_retain_partial_scope(self):
        qa = r.validate(self.work)
        self.assertEqual(qa["content"]["status"], "pass")
        self.assertEqual(qa["overall"]["status"], "partial")
        evidence = self.work / "browser.json"
        r.write(evidence, {"checks": [{"name": name, "status": "pass", "evidence": "Synthetic check record only"} for name in sorted(r.REQUIRED_BROWSER)]})
        accepted = r.record_browser(self.work, evidence)
        self.assertEqual(accepted["browser"]["status"], "pass")
        self.assertEqual(accepted["content"]["status"], "pass")
        self.assertEqual(accepted["overall"]["status"], "partial")
        self.assertEqual(accepted["reviewScopes"], self.paper["reviewScopes"])

    def test_validation_keeps_json_issue_objects_and_legacy_strings(self):
        issue = {"type": "acceptance-pending", "detail": {"path": "/synthetic/path", "expected": [1, 2]}}
        self.paper["issues"] = [issue, "legacy issue"]
        r.write(self.work / "paper.json", self.paper)
        qa = r.validate(self.work)
        self.assertEqual(qa["content"]["status"], "blocked")
        self.assertIn(issue, qa["content"]["blocked"])
        self.assertIn("legacy issue", qa["content"]["blocked"])
        self.assertEqual(json.loads((self.work / "qa-report.json").read_text())["content"]["blocked"][0], issue)


if __name__ == "__main__":
    unittest.main()
