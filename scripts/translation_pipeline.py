#!/usr/bin/env python3
"""Immutable tasks for native Agents; scripts never call a model or translation API."""
import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import socket
import sys
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10+ is required for micro-paper translation tasks")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from pipeline_common import structure_fingerprint, work_lock

_spec = importlib.util.spec_from_file_location("micro_paper_translation_reader", HERE / "reader.py")
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)
VERSION = 1
LOCK = ".micro-paper-write.lock"
TXN = ".translation-transaction"
RECEIPTS = "translation-receipts.json"
HEX = re.compile(r"^[a-f0-9]{64}$")
INSTRUCTION = (
    "Translate every target block faithfully with the native Agent in its configured model. "
    "Do not call a translation API. Do not change, split, merge, omit or summarize canonical English blocks. "
    "textPool is read-only context: translate only targets, retaining each blockId/enHash. "
    "Use the frozen glossary and source formatting evidence. Return complete Chinese text, UTF-16 "
    "italic/sup/sub ranges with sourceEvidence, issues, and individually justified invariantDecisions. "
    "Preserve numbers, units and explicit figure scopes/numbers/panels. Report unresolved facts; do not guess. "
    "Write one independent JSON response using the manifest's response path and envelope fields. "
    "Never edit paper.json, the glossary, batch files, other responses or acceptance receipts."
)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def bytes_hash(value):
    return hashlib.sha256(value).hexdigest()


def guarded_inputs(work, approval=None):
    paths = [work / name for name in ["paper.json", "source-manifest.json", "glossary.json", RECEIPTS, "source.pdf", "source-transcription-ledger.json"]]
    paths.append(Path(approval) if approval else work / "structure-approval.json")
    states = {}
    for path in paths:
        if not path.exists():
            states[str(path)] = None
            continue
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        states[str(path)] = hasher.hexdigest()
    return states


def read(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Non-finite JSON: {value}")))


def atomic_bytes(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError:
            pass
    finally:
        temporary.unlink(missing_ok=True)


def write(path, value):
    atomic_bytes(path, canonical(value) + b"\n")


def alive(pid):
    if type(pid) is not int or pid <= 0:
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@contextmanager
def writer_lock(work, operation, timeout=10):
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout < 0:
        raise ValueError("Lock timeout must be a finite nonnegative number")
    with work_lock(work, operation, timeout=timeout):
        if (work / TXN).exists():
            raise ValueError("Unfinished translation transaction: run recover before further writes")
        yield


def require_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing/non-text {label}")
    return value


def translation_state(paper, block, formatting=None):
    return {"zh": block.get("zh", ""), "zhHash": block.get("zhHash"), "status": block.get("translationStatus"),
            "issues": block.get("translationIssues", []), "decisions": block.get("invariantDecisions", {}),
            "formatting": formatting if formatting is not None else [f for f in paper.get("formatting", []) if f.get("blockId") == block["blockId"] and f.get("language") == "zh"]}


def snapshot(work, approval_path=None):
    paper = read(work / "paper.json")
    manifest = read(work / "source-manifest.json")
    glossary = read(work / "glossary.json")
    if not isinstance(glossary, dict):
        raise ValueError("glossary.json must be an object")
    source = bytes_hash((work / "source.pdf").read_bytes())
    if paper.get("sourceSha256") != source or manifest.get("sourceSha256") != source:
        raise ValueError("Source PDF/manifest identity mismatch")
    if not paper.get("documentId") or manifest.get("documentId") != paper["documentId"]:
        raise ValueError("Source manifest/canonical document identity mismatch")
    approval = read(approval_path or work / "structure-approval.json")
    transcription_path = work / "source-transcription-ledger.json"
    transcription_hash = paper.get("sourceTranscriptionLedgerSha256")
    has_transcription = any(s.get("transcription") for b in paper.get("blocks", []) for s in b.get("sourceSpans", []))
    if transcription_hash is not None or has_transcription or transcription_path.exists():
        if (not transcription_path.is_file() or not transcription_hash or
                bytes_hash(transcription_path.read_bytes()) != transcription_hash or
                approval.get("sourceTranscriptionLedgerSha256") != transcription_hash):
            raise ValueError("Approved independent transcription ledger identity is missing or changed")
    fingerprint = structure_fingerprint(paper)
    evidence = approval.get("evidence")
    if (approval.get("status") != "approved" or approval.get("sourceSha256") != source or
            approval.get("structureFingerprint") != fingerprint or not isinstance(evidence, list) or
            not evidence or any(not isinstance(item, str) or not item.strip() for item in evidence)):
        raise ValueError("Approved canonical structure with current source/fingerprint/evidence is required")
    ids = [b["blockId"] for b in paper["blocks"]]
    orders = [b["order"] for b in paper["blocks"]]
    if len(ids) != len(set(ids)) or len(orders) != len(set(orders)):
        raise ValueError("Duplicate canonical block ID/order")
    for block in paper["blocks"]:
        if block.get("enHash") != reader.textsha(block["en"]):
            raise ValueError("Stale canonical English hash; freeze and approve structure first")
        status = block.get("translationStatus")
        if status not in {"pending", "translated", "needs-review", "reviewed", "original-only"}:
            raise ValueError("Unknown translation status")
        if not isinstance(block.get("zh"), str) or block.get("zhHash") != reader.textsha(block["zh"]):
            raise ValueError("Stale or malformed canonical Chinese hash/text")
        if block["kind"] not in reader.EXEMPT:
            if status == "original-only":
                raise ValueError("original-only is forbidden for a translatable canonical block")
            if status in {"translated", "needs-review", "reviewed"} and not block["zh"].strip():
                raise ValueError("Translated/reviewed status requires nonblank Chinese text")
    return paper, manifest, glossary, approval, fingerprint


def source_locations(block):
    """Compact visual locators only; exact glyph ownership stays in the bound paper."""
    locations = {}
    for span in block["sourceSpans"]:
        location = locations.setdefault(span["pageId"], {"pageId": span["pageId"]})
        box = span.get("bbox")
        if isinstance(box, list) and len(box) == 4 and all(type(value) in {int, float} and math.isfinite(value) for value in box):
            previous = location.get("bbox", box)
            location["bbox"] = [min(previous[0], box[0]), min(previous[1], box[1]), max(previous[2], box[2]), max(previous[3], box[3])]
        if span.get("transcription"):
            location["transcription"] = True
    return list(locations.values())


def indexes(paper):
    blocks = sorted(paper["blocks"], key=lambda b: b["order"])
    by_id = {b["blockId"]: b for b in blocks}
    positions = {b["blockId"]: i for i, b in enumerate(blocks)}
    sections, formatting, zh_formatting, related = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(set)
    for section in paper.get("sections", []):
        for bid in section["blockIds"]:
            sections[bid].append({"sectionId": section["sectionId"], "titleEn": section["titleEn"]})
    for item in paper.get("formatting", []):
        if item.get("language") == "en":
            formatting[item["blockId"]].append(item)
        elif item.get("language") == "zh":
            zh_formatting[item["blockId"]].append(item)
    captions = {f["figureId"]: f.get("captionBlockIds", []) for f in paper.get("figures", [])}
    for reference in paper.get("inlineReferences", []):
        if reference.get("language") == "en":
            for figure_id in reference.get("figureIds", []):
                related[reference["blockId"]].update(captions.get(figure_id, []))
    states = {b["blockId"]: digest(translation_state(paper, b, zh_formatting[b["blockId"]])) for b in blocks}
    locations = {b["blockId"]: source_locations(b) for b in blocks}
    return blocks, by_id, positions, sections, formatting, related, states, locations


def payload_for(paper, glossary, structure, target_ids, idx=None):
    blocks, by_id, positions, sections, formatting, related, states, locations = idx or indexes(paper)
    pool_ids, targets = set(target_ids), []
    for bid in target_ids:
        block, position = by_id[bid], positions[bid]
        before = blocks[position - 1]["blockId"] if position else None
        after = blocks[position + 1]["blockId"] if position + 1 < len(blocks) else None
        captions = sorted(related[bid], key=lambda item: positions.get(item, len(blocks)))
        for item in [before, after, *captions]:
            if item is not None:
                if item not in by_id:
                    raise ValueError("Unknown canonical context/caption")
                pool_ids.add(item)
        targets.append({"blockId": bid, "enHash": block["enHash"], "kind": block["kind"],
                        "baseTranslationHash": states[bid],
                        "contextBefore": before, "contextAfter": after, "relatedCaptionIds": captions})
    pool = []
    for block in blocks:
        bid = block["blockId"]
        if bid in pool_ids:
            pool.append({"blockId": bid, "enHash": block["enHash"], "en": block["en"],
                         "sections": sections[bid], "formatting": formatting[bid], "sourceLocations": locations[bid]})
    return {"schemaVersion": VERSION, "taskType": "native-agent-translation", "instructions": INSTRUCTION,
            "sourceSha256": paper["sourceSha256"], "structureFingerprint": structure,
            "glossaryHash": digest(glossary), "glossary": glossary, "targets": targets, "textPool": pool}


def envelope(payload):
    key = digest(payload)
    return {"schemaVersion": VERSION, "batchId": key, "payloadHash": key, "payload": payload}


def prepare(work, approval=None, max_bytes=24000, queue="pending", retranslate=False):
    work = Path(work).resolve()
    if type(max_bytes) is not int or max_bytes <= 0:
        raise ValueError("max-bytes must be positive")
    if queue not in {"pending", "translated", "needs-review"} or queue != "pending" and not retranslate:
        raise ValueError("Translated/needs-review queues require explicit --retranslate")
    with writer_lock(work, "translation-prepare"):
        paper, _, glossary, approval_data, structure = snapshot(work, approval)
        idx = indexes(paper)
        queues = {state: [b["blockId"] for b in idx[0] if b["kind"] not in reader.EXEMPT and b["translationStatus"] == state]
                  for state in ["pending", "translated", "needs-review", "reviewed"]}
        targets = queues[queue]
        if any(idx[1][bid].get("zh") for bid in targets) and not retranslate:
            raise ValueError("Existing Chinese text requires explicit --retranslate")
        if not targets:
            return {"status": "nothing-to-translate", "queues": queues}
        batches, current = [], []
        for bid in targets:
            candidate = envelope(payload_for(paper, glossary, structure, current + [bid], idx))
            if len(canonical(candidate)) + 1 > max_bytes and current:
                batches.append(envelope(payload_for(paper, glossary, structure, current, idx)))
                current = []
                candidate = envelope(payload_for(paper, glossary, structure, [bid], idx))
            if len(canonical(candidate)) + 1 > max_bytes:
                raise ValueError(f"Complete block plus full task context exceeds max-bytes: {bid} requires {len(canonical(candidate)) + 1}; increase budget, never split the paragraph")
            current.append(bid)
        if current:
            batches.append(envelope(payload_for(paper, glossary, structure, current, idx)))
        manifest = {"schemaVersion": VERSION, "sourceSha256": paper["sourceSha256"], "structureFingerprint": structure,
                    "glossaryHash": digest(glossary), "approvalHash": digest(approval_data), "queue": queue,
                    "retranslate": retranslate, "maxBytes": max_bytes, "queuesAtPreparation": queues,
                    "batches": [{"batchId": b["batchId"], "payloadHash": b["payloadHash"],
                                 "file": "batch-" + b["batchId"] + ".json", "payloadBytes": len(canonical(b)) + 1,
                                 "response": "response-" + b["batchId"] + ".json"} for b in batches]}
        job_id = digest(manifest)
        manifest["jobId"] = job_id
        directory = work / "translation-jobs" / job_id
        if directory.exists():
            if read(directory / "manifest.json") != manifest or any(read(directory / entry["file"]) != batch for entry, batch in zip(manifest["batches"], batches)):
                raise ValueError("Immutable job exists with divergent contents")
        else:
            directory.parent.mkdir(exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix=".job-", dir=directory.parent))
            try:
                write(temporary / "manifest.json", manifest)
                for entry, batch in zip(manifest["batches"], batches):
                    write(temporary / entry["file"], batch)
                temporary.rename(directory)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        return {"status": "await-native-agent-responses", "jobId": job_id, "job": str(directory), "queues": queues,
                "tasks": [{"batch": str(directory / entry["file"]), "responseFilename": entry["response"],
                           "responseEnvelope": {"schemaVersion": VERSION, "jobId": job_id, "batchId": entry["batchId"],
                                                "payloadHash": entry["payloadHash"], "translations": []}}
                          for entry in manifest["batches"]]}


def load_job(work, job):
    directory = Path(job)
    if HEX.fullmatch(str(job)):
        directory = work / "translation-jobs" / str(job)
    directory = directory.resolve()
    if directory.parent != (work / "translation-jobs").resolve():
        raise ValueError("Job must be an immutable directory within this work's translation-jobs")
    manifest = read(directory / "manifest.json")
    unsigned = {k: v for k, v in manifest.items() if k != "jobId"}
    if manifest.get("jobId") != digest(unsigned) or directory.name != manifest["jobId"]:
        raise ValueError("Immutable job manifest hash mismatch")
    batches, target_ids = {}, set()
    if not manifest.get("batches"):
        raise ValueError("A translation job must contain at least one batch")
    for entry in manifest["batches"]:
        key = entry["batchId"]
        if not HEX.fullmatch(key) or key in batches or entry["file"] != f"batch-{key}.json":
            raise ValueError("Invalid/duplicate immutable batch identity")
        batch = read(directory / entry["file"])
        if batch != envelope(batch["payload"]) or batch["batchId"] != key or entry["payloadHash"] != key or len(canonical(batch)) + 1 != entry["payloadBytes"]:
            raise ValueError("Immutable batch/full task payload hash mismatch")
        ids = [item["blockId"] for item in batch["payload"]["targets"]]
        if len(ids) != len(set(ids)) or target_ids.intersection(ids):
            raise ValueError("Overlapping/duplicate job target blocks")
        target_ids.update(ids)
        batches[key] = batch
    return manifest, batches


def validate_translation(block, item):
    allowed = {"blockId", "enHash", "zh", "formatting", "issues", "invariantDecisions"}
    required = allowed - {"invariantDecisions"}
    if not isinstance(item, dict) or not required.issubset(item) or set(item) - allowed:
        raise ValueError("Malformed translation fields")
    if item["enHash"] != reader.textsha(block["en"]):
        raise ValueError("Stale response English hash")
    zh = require_text(item["zh"], "Chinese translation")
    if zh == block["en"]:
        raise ValueError("English copied as Chinese")
    if not isinstance(item["issues"], list) or any(not isinstance(issue, str) for issue in item["issues"]):
        raise ValueError("issues must be a string array")
    decisions = item.get("invariantDecisions", {})
    if not isinstance(decisions, dict) or any(not isinstance(value, str) for value in decisions.values()):
        raise ValueError("invariantDecisions must contain textual reasons")
    en_tokens, zh_tokens = reader.invariants(block["en"]), reader.invariants(zh)
    changed = {token for token in en_tokens.keys() | zh_tokens.keys() if en_tokens[token] != zh_tokens[token]}
    if any(not decisions.get(token, "").strip() for token in changed):
        raise ValueError(f"Changed invariant tokens: {sorted(changed)}")
    signature = lambda text: Counter((fid, tuple(ref["panelLabels"])) for ref in reader.parse_references(text) for fid in ref["figureIds"])
    if signature(block["en"]) != signature(zh):
        raise ValueError("Explicit figure scope, number or panel changed")
    if not isinstance(item["formatting"], list):
        raise ValueError("formatting must be an array")
    for fmt in item["formatting"]:
        if not isinstance(fmt, dict) or set(fmt) != {"start", "end", "kind", "sourceEvidence"}:
            raise ValueError("Malformed formatting or attempted identity override")
        if type(fmt["start"]) is not int or type(fmt["end"]) is not int:
            raise ValueError("Formatting UTF-16 coordinates must be integers")
        reader.validate_range(zh, fmt["start"], fmt["end"])
        if fmt["kind"] not in {"italic", "sup", "sub"}:
            raise ValueError("Unsupported formatting")
        require_text(fmt["sourceEvidence"], "formatting sourceEvidence")


def preflight(work, job, response_paths, approval=None):
    paper, source_manifest, glossary, approval_data, structure = snapshot(work, approval)
    job_manifest, batches = load_job(work, job)
    if (job_manifest["sourceSha256"] != paper["sourceSha256"] or job_manifest["structureFingerprint"] != structure or
            job_manifest["glossaryHash"] != digest(glossary) or job_manifest["approvalHash"] != digest(approval_data)):
        raise ValueError("Stale job source/structure/glossary/approval")
    receipts = read(work / RECEIPTS) if (work / RECEIPTS).exists() else {"schemaVersion": VERSION, "batches": {}}
    if receipts.get("schemaVersion") != VERSION or not isinstance(receipts.get("batches"), dict):
        raise ValueError("Malformed acceptance receipts; preserve and repair before accepting")
    responses = {}
    for path in response_paths:
        response = read(path)
        if not isinstance(response, dict) or set(response) != {"schemaVersion", "jobId", "batchId", "payloadHash", "translations"} or response["schemaVersion"] != VERSION:
            raise ValueError("Malformed response envelope")
        key = response["batchId"]
        if key not in batches or key in responses:
            raise ValueError("Duplicate, conflicting or unexpected response batch")
        if response["jobId"] != job_manifest["jobId"] or response["payloadHash"] != batches[key]["payloadHash"]:
            raise ValueError("Response job/full task payload hash mismatch")
        responses[key] = response
    if set(responses) != set(batches):
        raise ValueError("Provide exactly one independent response for every job batch")
    idx, accepted, fresh = indexes(paper), [], []
    for key, response in responses.items():
        target = batches[key]["payload"]["targets"]
        expected_ids = [item["blockId"] for item in target]
        items = response["translations"]
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ValueError("translations must be an array of objects")
        ids = [item.get("blockId") for item in items]
        if len(ids) != len(set(ids)) or set(ids) != set(expected_ids):
            raise ValueError("Missing, duplicate or unexpected translation block")
        receipt_key = job_manifest["jobId"] + ":" + key
        receipt = receipts["batches"].get(receipt_key)
        if receipt:
            if receipt.get("responseHash") != digest(response) or receipt.get("payloadHash") != key:
                raise ValueError("Conflicting response for an already accepted immutable batch")
            if receipt.get("afterStateHashes") != {bid: idx[6][bid] for bid in expected_ids}:
                raise ValueError("Accepted translations have changed since the receipt")
            accepted.append(key)
            continue
        current_payload = payload_for(paper, glossary, structure, expected_ids, idx)
        if digest(current_payload) != key:
            raise ValueError("Stale task context/formatting or conflicting current translation state")
        for item in items:
            validate_translation(idx[1][item["blockId"]], item)
        fresh.append(key)
    return {"paper": paper, "sourceManifest": source_manifest, "jobManifest": job_manifest,
            "responses": responses, "receipts": receipts, "fresh": fresh, "accepted": accepted}


def dry_run(work, job, response_paths, approval=None):
    work = Path(work).resolve()
    if (work / LOCK).exists() or (work / TXN).exists():
        raise ValueError("Writer/recovery active; retry read-only validation after it finishes")
    before = guarded_inputs(work, approval)
    plan = preflight(work, job, response_paths, approval)
    if (work / LOCK).exists() or guarded_inputs(work, approval) != before:
        raise ValueError("Concurrent state changed during read-only validation")
    return {"status": "validated-no-writes", "jobId": plan["jobManifest"]["jobId"],
            "batches": len(plan["responses"]), "newBatches": len(plan["fresh"]), "alreadyAccepted": len(plan["accepted"])}


def restore_transaction(work):
    directory = work / TXN
    if not directory.exists():
        return "no-transaction"
    if not (directory / "journal.json").exists():
        shutil.rmtree(directory)
        return "discarded-unprepared-staging"
    journal = read(directory / "journal.json")
    names = ["paper.json", "source-manifest.json", RECEIPTS]
    if journal.get("schemaVersion") != VERSION or set(journal.get("files", {})) != set(names):
        raise ValueError("Malformed transaction journal; retained for explicit repair")
    if journal.get("phase") == "committed":
        for name in names:
            if bytes_hash((work / name).read_bytes()) != journal["files"][name]["afterHash"]:
                raise ValueError("Committed transaction diverged; recovery will not overwrite newer state")
        shutil.rmtree(directory)
        return "cleaned-committed-transaction"
    if journal.get("phase") != "prepared":
        raise ValueError("Unknown transaction phase")
    # Check every backup and destination before restoring any; do not clobber external edits.
    for name in names:
        state = journal["files"][name]
        current = bytes_hash((work / name).read_bytes()) if (work / name).exists() else None
        if current not in {state["beforeHash"], state["afterHash"]}:
            raise ValueError("Transaction destination changed externally; automatic rollback refused")
        if state["beforeHash"] is not None and bytes_hash((directory / "before" / name).read_bytes()) != state["beforeHash"]:
            raise ValueError("Corrupt rollback backup")
    for name in names:
        state = journal["files"][name]
        if state["beforeHash"] is None:
            (work / name).unlink(missing_ok=True)
        else:
            atomic_bytes(work / name, (directory / "before" / name).read_bytes())
    shutil.rmtree(directory)
    return "rolled-back-incomplete-transaction"


def commit(work, output):
    directory = work / TXN
    directory.mkdir()
    journal = {"schemaVersion": VERSION, "phase": "prepared", "files": {}}
    try:
        for name, value in output.items():
            before = (work / name).read_bytes() if (work / name).exists() else None
            if before is not None:
                atomic_bytes(directory / "before" / name, before)
            atomic_bytes(directory / "after" / name, value)
            journal["files"][name] = {"beforeHash": bytes_hash(before) if before is not None else None, "afterHash": bytes_hash(value)}
        write(directory / "journal.json", journal)
        for name in output:
            state = journal["files"][name]
            current = bytes_hash((work / name).read_bytes()) if (work / name).exists() else None
            if current != state["beforeHash"]:
                raise ValueError("Concurrent external writer detected before transaction commit")
        for name in output:
            atomic_bytes(work / name, (directory / "after" / name).read_bytes())
        journal["phase"] = "committed"
        write(directory / "journal.json", journal)
        shutil.rmtree(directory)
    except BaseException:
        restore_transaction(work)
        raise


def accept_many(work, job, response_paths, approval=None, lock_timeout=10):
    work = Path(work).resolve()
    with writer_lock(work, "translation-accept-many", lock_timeout):
        before = guarded_inputs(work, approval)
        plan = preflight(work, job, response_paths, approval)
        if not plan["fresh"]:
            if guarded_inputs(work, approval) != before:
                raise ValueError("Concurrent non-cooperating writer changed state; no translation committed")
            return {"status": "already-accepted", "jobId": plan["jobManifest"]["jobId"], "batches": len(plan["accepted"]), "freezeCount": 0}
        paper = copy.deepcopy(plan["paper"])
        by_id = {b["blockId"]: b for b in paper["blocks"]}
        changed_zh = set()
        for key in plan["fresh"]:
            for item in plan["responses"][key]["translations"]:
                block = by_id[item["blockId"]]
                if block["zh"] != item["zh"]:
                    changed_zh.add(block["blockId"])
                block.update(zh=item["zh"], zhHash=reader.textsha(item["zh"]),
                             translationStatus="needs-review" if item["issues"] else "translated",
                             translationIssues=copy.deepcopy(item["issues"]), invariantDecisions=copy.deepcopy(item.get("invariantDecisions", {})))
                paper["formatting"] = [f for f in paper["formatting"] if not (f["blockId"] == block["blockId"] and f["language"] == "zh")]
                paper["formatting"].extend({"blockId": block["blockId"], "language": "zh", **fmt} for fmt in item["formatting"])
        # Bibliography spans are independently source-paired: never reuse offsets in changed ZH.
        invalidated = [ref for ref in paper.get("referenceCitations", []) if ref.get("language") == "zh" and ref.get("blockId") in changed_zh]
        if invalidated:
            paper["referenceCitations"] = [ref for ref in paper["referenceCitations"] if not (ref.get("language") == "zh" and ref.get("blockId") in changed_zh)]
            old_by_id = {b["blockId"]: b for b in plan["paper"]["blocks"]}
            reason = "Chinese text changed; bibliography citation pairing must be reviewed and rebuilt before linking."
            for ref in invalidated:
                bid = ref["blockId"]
                paper.setdefault("referenceCitationCandidates", []).append({
                    "id": "invalidated-" + digest([ref, by_id[bid]["zhHash"]])[:24],
                    "blockId": bid, "language": "zh", "status": "unresolved", "reason": reason,
                    "previousCitation": copy.deepcopy(ref), "previousZhHash": old_by_id[bid]["zhHash"],
                    "currentZhHash": by_id[bid]["zhHash"], "jobId": plan["jobManifest"]["jobId"]})
                by_id[bid]["translationStatus"] = "needs-review"
                if reason not in by_id[bid]["translationIssues"]:
                    by_id[bid]["translationIssues"].append(reason)
        # Keep approved EN links intact, regenerate only translated-language figure links.
        updated_ids = {item["blockId"] for key in plan["fresh"] for item in plan["responses"][key]["translations"]}
        paper["inlineReferences"] = [ref for ref in paper["inlineReferences"] if ref["language"] != "zh" or ref["blockId"] not in updated_ids]
        paper["inlineReferences"].extend({"blockId": block["blockId"], "language": "zh", **ref}
                                         for block in paper["blocks"] if block["blockId"] in updated_ids
                                         for ref in reader.parse_references(block.get("zh", "")))
        with tempfile.TemporaryDirectory(prefix=".translation-stage-", dir=work) as temporary:
            stage = Path(temporary)
            write(stage / "paper.json", paper)
            write(stage / "source-manifest.json", plan["sourceManifest"])
            reader.freeze(stage, keep_references=True)  # exactly once, on isolated staging state
            paper = read(stage / "paper.json")
            if structure_fingerprint(paper) != plan["jobManifest"]["structureFingerprint"]:
                raise ValueError("Translation unexpectedly changed approved canonical structure")
            current_states = indexes(paper)[6]
            receipts = copy.deepcopy(plan["receipts"])
            for key in plan["fresh"]:
                response = plan["responses"][key]
                receipts["batches"][plan["jobManifest"]["jobId"] + ":" + key] = {
                    "payloadHash": key, "responseHash": digest(response),
                    "afterStateHashes": {item["blockId"]: current_states[item["blockId"]] for item in response["translations"]}}
            if guarded_inputs(work, approval) != before:
                raise ValueError("Concurrent non-cooperating writer changed state; no translation committed")
            commit(work, {"paper.json": (stage / "paper.json").read_bytes(),
                          "source-manifest.json": (stage / "source-manifest.json").read_bytes(), RECEIPTS: canonical(receipts) + b"\n"})
        return {"status": "accepted-await-scientific-review", "jobId": plan["jobManifest"]["jobId"],
                "newBatches": len(plan["fresh"]), "alreadyAccepted": len(plan["accepted"]), "freezeCount": 1}


def checked_dead_borrowers(lock, owner):
    directory = lock / "borrowers"
    if not directory.exists():
        return []
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Recovery refuses malformed borrowed-writer evidence")
    dead = []
    for path in sorted(directory.iterdir()):
        if path.is_symlink() or not path.is_file():
            raise ValueError("Recovery refuses malformed borrowed-writer evidence")
        borrower = read(path)
        if (not isinstance(borrower, dict) or type(borrower.get("pid")) is not int or borrower["pid"] <= 0 or
                path.name != str(borrower["pid"]) + ".json" or borrower.get("parentPid") != owner.get("pid") or
                borrower.get("hostname") != socket.gethostname() or borrower.get("token") != owner.get("token") or
                not isinstance(borrower.get("token"), str) or not borrower["token"]):
            raise ValueError("Recovery refuses malformed, foreign-host or mismatched borrowed-writer evidence")
        if alive(borrower["pid"]):
            raise ValueError("Recovery refuses an active borrowed writer")
        dead.append(borrower)
    return dead


def recover(work):
    work = Path(work).resolve()
    if (work / ".source-transaction").exists():
        raise ValueError("Pending source transaction; preserve both journals and resolve source state before translation recovery")
    lock = work / LOCK
    dead_borrowers = []
    if lock.exists():
        owner = read(lock / "owner.json")
        if (not isinstance(owner, dict) or not isinstance(owner.get("token"), str) or not owner["token"] or
                owner.get("hostname") != socket.gethostname() or alive(owner.get("pid"))):
            raise ValueError("Recovery refuses an active, unknown-host or unverifiable writer")
        checked_dead_borrowers(lock, owner)
        # An exclusive claim prevents two recovery processes from sharing a dead lock.
        # Keep the original lock directory in place throughout rollback.
        try:
            (lock / "recovery-claim").mkdir()
        except FileExistsError:
            raise ValueError("Another recovery claim exists; retained for explicit inspection")
        try:
            if read(lock / "owner.json") != owner:
                raise ValueError("Lock owner changed during recovery")
            dead_borrowers = checked_dead_borrowers(lock, owner)
            if (work / ".source-transaction").exists():
                raise ValueError("Pending source transaction; preserve both journals before lock takeover")
        except BaseException:
            (lock / "recovery-claim").rmdir()
            raise
        token = uuid.uuid4().hex
        write(lock / "owner.json", {"pid": os.getpid(), "operation": "translation-recover", "createdAt": datetime.now(timezone.utc).isoformat(), "hostname": socket.gethostname(), "token": token})
    else:
        try:
            lock.mkdir()
        except FileExistsError:
            raise ValueError("Writer started during recovery; retry after it finishes")
        token = uuid.uuid4().hex
        write(lock / "owner.json", {"pid": os.getpid(), "operation": "translation-recover", "createdAt": datetime.now(timezone.utc).isoformat(), "hostname": socket.gethostname(), "token": token})
    try:
        if (work / ".source-transaction").exists():
            raise ValueError("Pending source transaction; preserve both journals before translation recovery")
        return {"status": restore_transaction(work), "verifiedDeadBorrowers": dead_borrowers}
    finally:
        if read(lock / "owner.json").get("token") == token:
            shutil.rmtree(lock)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_cli = commands.add_parser("prepare")
    prepare_cli.add_argument("work", type=Path)
    prepare_cli.add_argument("--approval", type=Path)
    prepare_cli.add_argument("--max-bytes", type=int, default=24000)
    prepare_cli.add_argument("--queue", choices=["pending", "translated", "needs-review"], default="pending")
    prepare_cli.add_argument("--retranslate", action="store_true")
    for name in ["validate-many", "accept-many"]:
        command = commands.add_parser(name)
        command.add_argument("work", type=Path)
        command.add_argument("--job", required=True)
        command.add_argument("--response", type=Path, action="append", required=True)
        command.add_argument("--approval", type=Path)
        if name == "accept-many":
            command.add_argument("--lock-timeout", type=float, default=10)
    recovery = commands.add_parser("recover")
    recovery.add_argument("work", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare(args.work, args.approval, args.max_bytes, args.queue, args.retranslate)
        elif args.command == "validate-many":
            result = dry_run(args.work, args.job, args.response, args.approval)
        elif args.command == "accept-many":
            result = accept_many(args.work, args.job, args.response, args.approval, args.lock_timeout)
        else:
            result = recover(args.work)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError, UnicodeError) as error:
        print(json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
