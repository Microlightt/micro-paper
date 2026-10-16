"""Synthetic source fixtures only; these tests are not a paper science review."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import reference_citations as r


def fixture(body="😀 Prior studies [1–4,7] agree. Others (5,3) differ.", zh="😀 既往研究[1–4,7]一致。其他研究（5,3）不同。"):
    p = {"sourceSha256": "a" * 64, "documentId": "synthetic-paper", "blocks": [], "formatting": [], "inlineReferences": []}
    m = {"sourceSha256": p["sourceSha256"], "documentId": p["documentId"], "pages": []}
    for index, (bid, kind, en, translated) in enumerate([("body", "body", body, zh)] + [(f"ref-{n}", "reference", f"{n}. Example author. A source title ({2000+n}).", "来源参考文献") for n in [1, 2, 3, 4, 7, 5]]):
        pid = "p" + str(index + 1)
        glyphs = [{"text": c, "font": "SyntheticRegular", "size": 10, "bbox": [i * 5, 20, i * 5 + 5, 30]} for i, c in enumerate(en)]
        m["pages"].append({"pageId": pid, "number": index + 1, "glyphs": glyphs})
        p["blocks"].append({"blockId": bid, "kind": kind, "order": index, "en": en, "zh": translated, "sourceSpans": [{"pageId": pid, "glyphStart": 0, "glyphEnd": len(glyphs), "bbox": [0, 20, len(glyphs)*5, 30]}]})
    p["referenceTargets"] = r.build_reference_targets(p, m)["targets"]
    return p, m


def span(p, text, lang="en", occurrence=0):
    canonical = p["blocks"][0][lang]
    starts = [i for i in range(len(canonical)) if canonical.startswith(text, i)]
    start = starts[occurrence]
    return {"blockId": "body", "language": lang, "start": r.u16len(canonical[:start]), "end": r.u16len(canonical[:start + len(text)])}


def approved(p, m, text="[1–4,7]", zh="[1–4,7]"):
    en = {**span(p, text), "reviewNote": "Synthetic PDF context explicitly identifies bibliography citation.", "style": "bracket"}
    decisions = [en]
    if zh is not None:
        decisions.append({**span(p, zh, "zh"), "sourceEnCitationId": r.citation_id("body", "en", en["start"], en["end"]), "reviewNote": "Localized occurrence checked against approved English citation."})
    built = r.build_reference_citations(p, m, decisions)
    if built["audit"]["errors"]:
        raise AssertionError(built["audit"])
    p["referenceCitations"] = built["citations"]
    return p


class LabelParsing(unittest.TestCase):
    def test_lists_ranges_unicode_and_lexical_order(self):
        for text, numbers in [("1–4,7", [1, 2, 3, 4, 7]), ("[5,3,5]", [5, 3]), ("（７）", None), ("⁵,³", [5, 3]), ("［1，3−4］", [1, 3, 4]), ("(7, 1-2)", [7, 1, 2])]:
            with self.subTest(text=text):
                if numbers is None:
                    with self.assertRaises(ValueError): r.parse_label(text)
                else:
                    self.assertEqual(r.parse_label(text), numbers)

    def test_not_guessing_bad_or_semantically_different_syntax(self):
        for text in ["4–1", "[1)", "[0]", "p<0.05", "Fig. 1", "1.5", "1 and 2", "1;2", "-2", "1–99999999", "1e3", "[]", "1,", "1-2-3"]:
            with self.subTest(text=text), self.assertRaises(ValueError): r.parse_label(text)

    def test_utf16_non_bmp_and_surrogate_guard(self):
        self.assertEqual(r.u16slice("😀[1]", 2, 5), "[1]")
        for start, end in [(0, 1), (1, 2), (True, 2), (2, 2), (-1, 2), (0, 99)]:
            with self.subTest(start=start, end=end), self.assertRaises(ValueError): r.u16slice("😀[1]", start, end)


class SourceTargets(unittest.TestCase):
    def test_targets_require_actual_prefix_and_unique_reference_block(self):
        p, m = fixture()
        before = copy.deepcopy((p, m))
        self.assertEqual(r.validate_reference_citations(p, m), [])
        self.assertEqual([t["number"] for t in p["referenceTargets"]], [1, 2, 3, 4, 7, 5])
        self.assertEqual((p, m), before)
        p["referenceTargets"][0]["number"] = 2
        self.assertTrue(r.validate_reference_citations(p, m))

    def test_plain_space_number_prefix_can_be_proven(self):
        p, m = fixture()
        block = p["blocks"][1]
        block["en"] = block["en"].replace("1. ", "1  ", 1)
        m["pages"][1]["glyphs"][1]["text"] = " "
        p["referenceTargets"] = r.build_reference_targets(p, m)["targets"]
        self.assertEqual(r.validate_reference_citations(p, m), [])
        self.assertEqual(p["referenceTargets"][0]["sourceEvidence"]["exactText"], "1  ")

    def test_duplicate_number_does_not_choose_first(self):
        p, m = fixture()
        p["blocks"][2]["en"] = p["blocks"][2]["en"].replace("2.", "1.", 1)
        m["pages"][2]["glyphs"][0]["text"] = "1"
        built = r.build_reference_targets(p, m)
        self.assertNotIn(1, [t["number"] for t in built["targets"]])
        self.assertEqual(len(built["unresolved"]), 2)

    def test_source_number_not_inferred_from_order_or_later_year(self):
        p, m = fixture()
        p["blocks"][1]["kind"] = "body"
        self.assertTrue(any("reference-kind" in e for e in r.validate_reference_citations(p, m)))
        p, m = fixture()
        evidence = p["referenceTargets"][0]["sourceEvidence"]
        evidence.update(exactText="1", glyphRanges=[{"pageId": "p2", "glyphStart": len(m["pages"][1]["glyphs"])-3, "glyphEnd": len(m["pages"][1]["glyphs"])-2}])
        self.assertTrue(r.validate_reference_citations(p, m))

    def test_wrong_source_or_unowned_glyphs_rejected(self):
        for mutation in [lambda p,m: m.update(sourceSha256="b"*64), lambda p,m: m.update(documentId="other"), lambda p,m: p["referenceTargets"][0]["sourceEvidence"].update(exactText="2. "), lambda p,m: p["referenceTargets"][0]["sourceEvidence"]["glyphRanges"][0].update(pageId="p3")]:
            p,m=fixture(); mutation(p,m)
            self.assertTrue(r.validate_reference_citations(p,m))

    def test_missing_canonical_prefix_needs_explicit_source_review(self):
        p,m=fixture(); p["blocks"][1]["en"]="Example author. A source title."
        self.assertTrue(r.validate_reference_citations(p,m))
        p["referenceTargets"][0]["sourceEvidence"].update(verification="reviewed-source", reviewNote="The source number is retained in original glyph provenance; canonical text source edit is separately recorded.")
        self.assertEqual(r.validate_reference_citations(p,m),[])


class CitationAudit(unittest.TestCase):
    def test_exact_en_zh_source_pairs_and_read_only_audit(self):
        p,m=fixture(); approved(p,m); before=copy.deepcopy((p,m))
        report=r.audit_reference_citations(p,m)
        self.assertEqual(report["status"],"pass")
        self.assertEqual(report["counts"], {"targets":6,"enCitations":1,"zhCitations":1,"unresolvedCandidates":0})
        self.assertEqual((p,m),before)

    def test_lexical_order_kept_for_nonascending_lists(self):
        p,m=fixture(); approved(p,m,"(5,3)","（5,3）")
        self.assertEqual(p["referenceCitations"][0]["numbers"],[5,3])
        self.assertEqual(r.validate_reference_citations(p,m),[])

    def test_unreviewed_typography_is_not_approved(self):
        p,m=fixture()
        built=r.build_reference_citations(p,m,[span(p,"[1–4,7]")])
        self.assertEqual(built["citations"],[])
        self.assertTrue(any("semantics" in e for e in built["audit"]["errors"]))

    def test_unknown_reference_exact_text_numbers_and_offsets_fail(self):
        for mutate in [lambda p: p["referenceCitations"][0].update(exactText="[1]"), lambda p: p["referenceCitations"][0].update(numbers=[1,2,3,4,99]), lambda p: p["referenceCitations"][0].update(start=0,end=1), lambda p: p["referenceCitations"][0].update(numbers=[True]), lambda p: p["referenceCitations"][0].update(numbers=[1,1]), lambda p: p["referenceCitations"][0].update(id="fake")]:
            p,m=fixture();approved(p,m);mutate(p)
            self.assertTrue(r.validate_reference_citations(p,m))

    def test_repeated_same_literal_cannot_borrow_other_occurrence_evidence(self):
        p,m=fixture("Earlier [1]. Later [1].", "早先[1]。后来[1]。")
        approved(p,m,"[1]",None)
        record=p["referenceCitations"][0]
        next_span=span(p,"[1]",occurrence=1)
        record.update(next_span,id=r.citation_id("body","en",next_span["start"],next_span["end"]))
        self.assertTrue(any("different canonical occurrence" in e for e in r.validate_reference_citations(p,m)))

    def test_source_edit_manual_evidence_is_bound_to_exact_text_and_occurrence(self):
        p,m=fixture(); approved(p,m,zh=None)
        record=p["referenceCitations"][0]
        record["sourceEvidence"].update(verification="reviewed-source")
        self.assertTrue(r.validate_reference_citations(p,m))
        record["sourceEvidence"].update(canonicalTextHash=r._hash(p["blocks"][0]["en"]),canonicalStart=record["start"],canonicalEnd=record["end"])
        self.assertEqual(r.validate_reference_citations(p,m),[])
        p["blocks"][0]["en"]+=" changed"
        self.assertTrue(r.validate_reference_citations(p,m))

    def test_zh_requires_same_block_same_numbers_and_approved_en(self):
        for mutate in [lambda p:p["referenceCitations"][1].update(sourceEnCitationId="missing"),lambda p:p["referenceCitations"].pop(0),lambda p:p["referenceCitations"][1]["sourceEvidence"].update(reviewNote=""),lambda p:p["referenceCitations"][0]["sourceEvidence"].pop("reviewNote")]:
            p,m=fixture();approved(p,m);mutate(p)
            self.assertTrue(r.validate_reference_citations(p,m))

    def test_overlap_duplicate_and_figure_link_collision_rejected(self):
        p,m=fixture();approved(p,m)
        p["referenceCitations"].append(copy.deepcopy(p["referenceCitations"][0]))
        self.assertTrue(any("overlap" in e for e in r.validate_reference_citations(p,m)))
        p,m=fixture();approved(p,m)
        p["inlineReferences"]=[{**span(p,"[1–4,7]"),"figureIds":["main:1"]}]
        self.assertTrue(any("figure/table" in e for e in r.validate_reference_citations(p,m)))

    def test_numeric_metadata_and_ineligible_kinds_cannot_be_linked(self):
        p,m=fixture();approved(p,m)
        p["articleInfo"]={"fields":[{"key":"authors","sourceBlockIds":["body"]}]}
        self.assertTrue(any("metadata" in e for e in r.validate_reference_citations(p,m)))
        self.assertEqual(r.discover_candidates(p,m),[])
        for kind in ["heading","reference","equation","table","figure-label","header-footer"]:
            p,m=fixture();approved(p,m);p["blocks"][0]["kind"]=kind
            self.assertTrue(r.validate_reference_citations(p,m))

    def test_optional_empty_fields_are_backward_compatible(self):
        self.assertEqual(r.validate_reference_citations({}),[])
        for value in [None,{},"bad"]:
            self.assertTrue(r.validate_reference_citations({"referenceTargets":value}))
        p,m=fixture()
        self.assertTrue(r.validate_reference_citations(p))


class ConservativeDiscovery(unittest.TestCase):
    def test_source_only_inventory_is_independent_stable_and_does_not_mutate(self):
        p,m=fixture(); before=copy.deepcopy(m)
        inventory=r.source_candidate_inventory(m)
        self.assertEqual(m,before)
        self.assertEqual(inventory,r.source_candidate_inventory(m))
        self.assertEqual(len(inventory["pages"]),len(m["pages"]))
        self.assertTrue(any(c["role"]=="bibliography-prefix" and c["numbers"]==[1] for c in inventory["candidates"]))
        self.assertTrue(any(c["role"]=="inline-citation" and c["numbers"]==[1,2,3,4,7] for c in inventory["candidates"]))
        self.assertTrue(all(c["status"]=="unresolved" for c in inventory["candidates"]))
        p["blocks"].clear()
        self.assertEqual(inventory,r.source_candidate_inventory(m))

    def test_source_only_inventory_preserves_actual_glyph_ranges(self):
        p,m=fixture("Prior work1 agrees.","既往工作1一致。")
        index=p["blocks"][0]["en"].index("1")
        m["pages"][0]["glyphs"][index].update(size=6,bbox=[index*5,17,index*5+3,23])
        inventory=r.source_candidate_inventory(m)
        matches=[c for c in inventory["candidates"] if c["pageId"]=="p1" and c["style"]=="superscript"]
        self.assertEqual(len(matches),1)
        self.assertEqual(matches[0]["glyphRanges"],[{"pageId":"p1","glyphStart":index,"glyphEnd":index+1}])
        self.assertEqual(matches[0]["exactText"],"1")

    def test_source_inventory_separates_column_numbered_prefixes(self):
        p,m=fixture()
        left=copy.deepcopy(m["pages"][1]["glyphs"])
        right=copy.deepcopy(m["pages"][2]["glyphs"])
        for glyph in right:
            glyph["bbox"][0]+=400
            glyph["bbox"][2]+=400
        m["pages"]=[{"pageId":"p1","glyphs":left+right}]
        inventory=r.source_candidate_inventory(m)
        numbers=[c["numbers"] for c in inventory["candidates"] if c["role"]=="bibliography-prefix"]
        self.assertEqual(numbers,[[1],[2]])

    def test_years_pvalues_figures_units_and_equations_never_become_links(self):
        p,m=fixture("Year (2020), P (1), Fig. (2), 10 mm², x³ and observations [1].", "年份（2020），图（2），以及研究[1]。")
        candidates=r.discover_candidates(p,m)
        self.assertTrue(candidates)
        self.assertTrue(all(c["status"]=="unresolved" for c in candidates))
        self.assertNotIn("referenceCitations",p)
        p["referenceCitationCandidates"]=candidates
        report=r.audit_reference_citations(p,m)
        self.assertEqual(report["status"],"partial")
        self.assertEqual(report["counts"]["enCitations"],0)

    def test_superscript_geometry_discovers_but_does_not_approve(self):
        p,m=fixture("Prior work1 agrees.", "既往研究1一致。")
        index=p["blocks"][0]["en"].index("1")
        m["pages"][0]["glyphs"][index].update(size=6,bbox=[index*5,17,index*5+3,23])
        candidates=r.discover_candidates(p,m)
        self.assertTrue(any(c["exactText"]=="1" and c["style"]=="superscript" for c in candidates))
        self.assertTrue(all(c["status"]=="unresolved" for c in candidates))

    def test_formatting_candidate_is_deduplicated_and_utf16_exact(self):
        p,m=fixture("😀 Prior work¹ agrees.", "😀 既往工作¹一致。")
        p["formatting"]=[{**span(p,"¹"),"kind":"sup"}]
        candidates=r.discover_candidates(p)
        en=[c for c in candidates if c["language"]=="en"]
        self.assertEqual(len(en),1)
        self.assertEqual(r.u16slice(p["blocks"][0]["en"],en[0]["start"],en[0]["end"]),"¹")

    def test_unmappable_source_text_does_not_guess_offsets(self):
        p,m=fixture();p["blocks"][0]["en"]=p["blocks"][0]["en"].replace("studies","study")
        with self.assertRaises(ValueError):r.make_source_evidence(p,m,**{"block_id":"body","start":span(p,"[1–4,7]")["start"],"end":span(p,"[1–4,7]")["end"]})

    def test_whitespace_only_layout_differences_keep_exact_occurrence_map(self):
        p,m=fixture()
        p["blocks"][0]["en"]=p["blocks"][0]["en"].replace("Prior studies", "Prior\n  studies")
        approved(p,m,zh=None)
        self.assertEqual(r.validate_reference_citations(p,m),[])

    def test_malformed_evidence_is_reported_without_exception(self):
        for evidence in [None, [], {}, {"glyphRanges":[]}, {"sourceSha256":"a"*64,"role":"inline-citation","verification":"glyph-map","glyphRanges":[{"pageId":"p1","glyphStart":False,"glyphEnd":1}]}]:
            p,m=fixture();approved(p,m,zh=None)
            p["referenceCitations"][0]["sourceEvidence"]=evidence
            self.assertTrue(r.validate_reference_citations(p,m))


if __name__ == "__main__":
    unittest.main()
