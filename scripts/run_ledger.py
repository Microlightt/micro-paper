#!/usr/bin/env python3
"""Evidence-bound first-run timing. No model calls, inferred timings or article caches."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pipeline_common import canonical_bytes, digest, work_lock

STAGES = ("extraction", "structure", "figures", "translation", "review", "package", "browser")
KINDS = ("active", "waiting", "rework")
LEDGER = "run-ledger"
DEFAULT_SCOPE = {"coverage": "full-article", "translation": "full-article",
                 "scientificReview": "full-article", "browser": "desktop-and-mobile"}
CLOCK_TOLERANCE_NS = 5_000_000_000


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_identity(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("Expected a regular file: " + str(path))
    before = path.stat()
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("File changed while hashing: " + str(path))
    return {"path": str(path), "sha256": sha.hexdigest(), "bytes": after.st_size}


def skill_identity(root):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Skill root must be a directory")
    files = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(p in {".git", "__pycache__"} for p in relative.parts) or path.name == ".DS_Store" or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise ValueError("Skill tree contains a symlink: " + str(relative))
        if path.is_file():
            identity = file_identity(path)
            files.append({"path": relative.as_posix(), "sha256": identity["sha256"], "bytes": identity["bytes"]})
    if not files:
        raise ValueError("Skill tree is empty")
    return {"root": str(root), "sha256": digest(files), "files": files,
            "excluded": [".git/**", "__pycache__/**", "*.pyc", ".DS_Store"]}


def runtime_identity():
    versions = {}
    for name in ("pdfplumber", "pypdfium2", "Pillow"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    node = shutil.which("node")
    try:
        versions["node"] = subprocess.check_output([node, "--version"], text=True, timeout=5).strip() if node else None
    except (OSError, subprocess.SubprocessError):
        versions["node"] = None
    return {"hostname": socket.gethostname(), "platform": platform.platform(),
            "machine": platform.machine(), "processor": platform.processor(),
            "cpuCount": os.cpu_count(), "python": platform.python_version(),
            "pythonImplementation": platform.python_implementation(), "pythonExecutable": sys.executable,
            "versions": versions}


def clock():
    # monotonic is shared across processes on supported Python platforms. The
    # UTC-origin check conservatively refuses reboot/clock-domain ambiguity.
    monotonic = time.monotonic_ns()
    utc = time.time_ns()
    return {"utc": datetime.fromtimestamp(utc / 1e9, timezone.utc).isoformat(),
            "utcNs": utc, "monotonicNs": monotonic,
            "clockDomain": {"hostname": socket.gethostname(),
                            "implementation": time.get_clock_info("monotonic").implementation},
            "estimatedBootUtcNs": utc - monotonic}


def check_clock(first, previous, current):
    if (first["clockDomain"] != current["clockDomain"]
            or current["monotonicNs"] < previous["monotonicNs"]
            or abs(current["estimatedBootUtcNs"] - first["estimatedBootUtcNs"]) > CLOCK_TOLERANCE_NS):
        raise ValueError("Monotonic clock continuity is uncertain (host, reboot or wall-clock shift); do not infer elapsed time")


def clean_audit(work, source):
    observed = []
    for path in sorted(work.rglob("*")):
        relative = path.relative_to(work)
        if relative.parts[0] == ".micro-paper-write.lock":
            continue
        if path.is_symlink() or (not path.is_dir() and path.resolve() != source):
            raise ValueError("First-run work directory must be empty or contain only the input source PDF: " + str(relative))
        if path.is_file():
            observed.append(relative.as_posix())
    return {"status": "passed", "policy": "empty-or-only-the-input-source-file",
            "observedFiles": observed, "scope": "work-directory-at-init",
            "limitation": "Does not inspect external agent context or prove absence of external caches."}


def load_events(work):
    directory = Path(work).resolve() / LEDGER / "events"
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("No valid run ledger; run init in a clean output directory")
    names = sorted(p.name for p in directory.iterdir())
    if not names or any(not name.endswith(".json") or len(name) != 13 or not name[:8].isdigit() for name in names):
        raise ValueError("Incomplete or unexpected ledger files; preserve them for inspection")
    events = []
    previous_hash = None
    for sequence, name in enumerate(names, 1):
        if name != f"{sequence:08d}.json":
            raise ValueError("Ledger sequence has a gap")
        path = directory / name
        if path.is_symlink():
            raise ValueError("Ledger events cannot be symlinks")
        event = read_json(path)
        supplied = event.get("eventHash")
        body = {k: v for k, v in event.items() if k != "eventHash"}
        if event.get("sequence") != sequence or event.get("previousHash") != previous_hash or supplied != digest(body):
            raise ValueError("Ledger event hash or chain is invalid")
        if sequence == 1 and event.get("type") != "init":
            raise ValueError("Ledger must begin with init")
        if events:
            check_clock(events[0]["time"], events[-1]["time"], event["time"])
            if events[-1]["type"] == "complete":
                raise ValueError("Events follow a terminal completion")
        events.append(event)
        previous_hash = supplied
    if names != sorted(p.name for p in directory.iterdir()):
        raise ValueError("Ledger changed during read; retry")
    return events


def append_event(work, events, kind, data):
    stamp = clock()
    if events:
        check_clock(events[0]["time"], events[-1]["time"], stamp)
        if events[-1]["type"] == "complete":
            raise ValueError("Completed runs are immutable; initialize another clean run")
    event = {"schemaVersion": 1, "sequence": len(events) + 1, "type": kind,
             "previousHash": events[-1]["eventHash"] if events else None,
             "time": stamp, "data": data}
    event["eventHash"] = digest(event)
    directory = Path(work) / LEDGER / "events"
    destination = directory / f"{event['sequence']:08d}.json"
    temporary = directory / (".pending-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as stream:
            stream.write(canonical_bytes(event) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Exclusive, atomic publication. Never replace or truncate an event.
        os.link(temporary, destination)
        temporary.unlink()
        if os.name == "posix":
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BaseException:
        if temporary.exists():
            temporary.unlink()
        raise
    return event


def init_run(work, source, skill_root, config, scope=None, requested_model=None,
             requested_thinking=None, requested_service_tier=None, requested_max_workers=1):
    work, source, skill_root = Path(work).resolve(), Path(source).resolve(strict=True), Path(skill_root).resolve(strict=True)
    if work == skill_root or skill_root in work.parents:
        raise ValueError("Run outputs must be outside the skill tree")
    if not isinstance(config, dict) or not isinstance(scope or DEFAULT_SCOPE, dict):
        raise ValueError("Config and scope must be JSON objects")
    if not isinstance(requested_max_workers, int) or requested_max_workers < 1:
        raise ValueError("requestedMaxWorkers must be a positive integer")
    with work_lock(work, "ledger-init"):
        audit = clean_audit(work, source)
        identity = file_identity(source)
        if identity["bytes"] == 0:
            raise ValueError("Input source is empty")
        scope = DEFAULT_SCOPE.copy() if scope is None else scope
        data = {"runId": uuid.uuid4().hex, "source": identity, "skillTree": skill_identity(skill_root),
                "runtime": runtime_identity(), "cleanStartAudit": audit,
                "scope": scope, "scopeHash": digest(scope), "config": config,
                "requested": {"model": requested_model, "thinking": requested_thinking,
                              "serviceTier": requested_service_tier, "maxWorkers": requested_max_workers},
                "actualModel": {"status": "unknown", "model": None, "thinking": None, "serviceTier": None,
                                "reason": "No trusted backend runtime identity is exposed to this local ledger."}}
        data["comparisonConfigHash"] = digest({"config": config, "requested": data["requested"]})
        (work / LEDGER / "events").mkdir(parents=True, exist_ok=False)
        event = append_event(work, [], "init", data)
    return {"runId": data["runId"], "scopeHash": data["scopeHash"], "eventHash": event["eventHash"],
            "sourceSha256": identity["sha256"], "skillTreeSha256": data["skillTree"]["sha256"],
            "comparisonConfigHash": data["comparisonConfigHash"],
            "actualModel": data["actualModel"]}


def spans_from(events):
    spans = {}
    for event in events[1:]:
        data = event["data"]
        if event["type"] == "start":
            if data["spanId"] in spans or data["stage"] not in STAGES or data["kind"] not in KINDS:
                raise ValueError("Invalid or duplicate span")
            spans[data["spanId"]] = {**data, "start": event["time"], "finish": None}
        elif event["type"] == "finish":
            span = spans.get(data["spanId"])
            if not span or span["finish"] is not None:
                raise ValueError("Unknown or already finished span")
            span.update({"finish": event["time"], **{k: v for k, v in data.items() if k != "spanId"}})
        elif event["type"] != "complete":
            raise ValueError("Unknown event type")
    return spans


def start_span(work, stage, kind="active", label="", command=None, lock_timeout=10):
    if stage not in STAGES or kind not in KINDS:
        raise ValueError("Unknown stage or span kind")
    with work_lock(work, "ledger-start", timeout=lock_timeout):
        events = load_events(work)
        data = {"spanId": uuid.uuid4().hex, "stage": stage, "kind": kind, "label": label}
        if command:
            data["command"] = list(command)
        event = append_event(work, events, "start", data)
    return {**data, "startedAt": event["time"]}


def evidence_identities(paths):
    identities = [file_identity(path) for path in paths]
    if any(item["bytes"] == 0 for item in identities):
        raise ValueError("Evidence cannot be empty")
    if len({item["path"] for item in identities}) != len(identities):
        raise ValueError("Duplicate evidence path")
    return identities


def finish_span(work, span_id, status="completed", evidence=(), note="", resolves=(), exit_code=None, lock_timeout=10):
    if status not in {"completed", "failed", "blocked"}:
        raise ValueError("Invalid span status")
    if exit_code is not None and (not isinstance(exit_code, int) or (exit_code != 0 and status == "completed")):
        raise ValueError("A failing process cannot be completed")
    with work_lock(work, "ledger-finish", timeout=lock_timeout):
        events = load_events(work)
        spans = spans_from(events)
        span = spans.get(span_id)
        if not span or span["finish"] is not None:
            raise ValueError("Unknown or already finished span")
        for target in resolves:
            failed = spans.get(target)
            if status != "completed" or span["kind"] == "waiting" or not failed or failed.get("status") not in {"failed", "blocked"} or failed["stage"] != span["stage"]:
                raise ValueError("Only a completed work span can explicitly resolve a failed/blocked span of the same stage")
        data = {"spanId": span_id, "status": status, "evidence": evidence_identities(evidence),
                "note": note, "resolves": list(resolves)}
        if exit_code is not None:
            data["exitCode"] = exit_code
        event = append_event(work, events, "finish", data)
    return {**data, "finishedAt": event["time"],
            "elapsedSeconds": (event["time"]["monotonicNs"] - span["start"]["monotonicNs"]) / 1e9}


def verify_identity(identity):
    try:
        current = file_identity(identity["path"])
        return current["sha256"] == identity["sha256"] and current["bytes"] == identity["bytes"]
    except (OSError, ValueError):
        return False


def quality_identity(path, initial, spans):
    identity = file_identity(path)
    document = read_json(path)
    binding = {"runId": initial["runId"], "sourceSha256": initial["source"]["sha256"],
               "skillTreeSha256": initial["skillTree"]["sha256"],
               "comparisonConfigHash": initial["comparisonConfigHash"], "scopeHash": initial["scopeHash"]}
    if document.get("status") != "passed" or any(document.get(key) != value for key, value in binding.items()):
        raise ValueError("Quality evidence must have status passed and match this runId, sourceSha256, skillTreeSha256, comparisonConfigHash and scopeHash")
    checks = document.get("checks", [])
    if not isinstance(checks, list) or len(checks) != len(STAGES) or {c.get("stage") for c in checks} != set(STAGES):
        raise ValueError("Quality evidence requires exactly one passed check for every stage")
    linked = []
    for check in checks:
        if check.get("status") != "passed" or not isinstance(check.get("evidenceFiles"), list) or not check["evidenceFiles"]:
            raise ValueError("Every quality check needs passed status and actual evidenceFiles")
        paths = [Path(p) if Path(p).is_absolute() else Path(path).resolve().parent / p for p in check["evidenceFiles"]]
        identities = evidence_identities(paths)
        accepted = [item for span in spans.values()
                    if span["stage"] == check["stage"] and span["kind"] != "waiting" and span.get("status") == "completed"
                    for item in span.get("evidence", [])]
        if any(item not in accepted for item in identities):
            raise ValueError("Quality evidence files must already be bound to a completed work span of this run and stage: " + check["stage"])
        linked.append({"stage": check["stage"], "files": identities})
    return {"document": identity, "checks": linked,
            "verification": "File existence, hashes, scope and declared statuses only; does not prove scientific review or browser actions occurred."}


def completion_issues(events, spans, quality=None):
    issues = []
    if any(span["finish"] is None for span in spans.values()):
        issues.append("open-spans")
    resolved = {item for span in spans.values() if span.get("status") == "completed" for item in span.get("resolves", [])}
    for stage in STAGES:
        successful = [s for s in spans.values() if s["stage"] == stage and s["kind"] != "waiting" and s.get("status") == "completed"]
        if not successful or any(not s.get("evidence") for s in successful):
            issues.append("missing-completed-stage-evidence:" + stage)
    if any(s.get("status") in {"failed", "blocked"} and sid not in resolved for sid, s in spans.items()):
        issues.append("unresolved-failed-or-blocked-spans")
    if quality is None:
        issues.append("missing-quality-evidence")
    if events[0]["data"]["scope"] != DEFAULT_SCOPE:
        issues.append("scope-is-not-full-first-run")
    return issues


def binding_issues(initial, spans, quality=None):
    issues = []
    if not verify_identity(initial["source"]):
        issues.append("source-changed-or-unavailable")
    try:
        if skill_identity(initial["skillTree"]["root"])["sha256"] != initial["skillTree"]["sha256"]:
            issues.append("skill-tree-changed")
    except (OSError, ValueError):
        issues.append("skill-tree-unavailable")
    for sid, span in spans.items():
        if any(not verify_identity(item) for item in span.get("evidence", [])):
            issues.append("stage-evidence-changed:" + sid)
    if quality and (not verify_identity(quality["document"]) or any(not verify_identity(item) for check in quality["checks"] for item in check["files"])):
        issues.append("quality-evidence-changed-or-unavailable")
    return issues


def complete_run(work, status="completed", quality_evidence=None, note="", lock_timeout=10):
    if status not in {"completed", "partial", "blocked"}:
        raise ValueError("Invalid run status")
    with work_lock(work, "ledger-complete", timeout=lock_timeout):
        events = load_events(work)
        spans = spans_from(events)
        if any(span["finish"] is None for span in spans.values()):
            raise ValueError("Finish every open span before terminating the run")
        quality = quality_identity(quality_evidence, events[0]["data"], spans) if quality_evidence else None
        issues = completion_issues(events, spans, quality) + binding_issues(events[0]["data"], spans, quality)
        if status == "completed" and issues:
            raise ValueError("Cannot claim a full completed first run: " + ", ".join(issues))
        event = append_event(work, events, "complete", {"status": status, "qualityEvidence": quality, "limitations": issues, "note": note})
    return {"status": status, "eventHash": event["eventHash"], "limitations": issues,
            "elapsedSeconds": (event["time"]["monotonicNs"] - events[0]["time"]["monotonicNs"]) / 1e9}


def interval_stats(intervals):
    points = []
    for start, end in intervals:
        if end > start:
            points.extend([(start, 1), (end, -1)])
    points.sort()  # Finish before start at a shared instant: no false overlap.
    live = maximum = union = 0
    previous = None
    for stamp, change in points:
        if previous is not None and live:
            union += stamp - previous
        live += change
        maximum = max(maximum, live)
        previous = stamp
    return {"unionSeconds": union / 1e9, "maxConcurrentSpans": maximum,
            "sumSpanSeconds": sum(end - start for start, end in intervals) / 1e9}


def report_run(work):
    events = load_events(work)
    initial = events[0]["data"]
    spans = spans_from(events)
    terminal = events[-1] if events[-1]["type"] == "complete" else None
    end = terminal["time"] if terminal else clock()
    check_clock(events[0]["time"], events[-1]["time"], end)
    quality = terminal["data"].get("qualityEvidence") if terminal else None
    issues = completion_issues(events, spans, quality) + binding_issues(initial, spans, quality)
    status = terminal["data"]["status"] if terminal else "running"
    if status != "completed":
        issues.insert(0, "run-not-full-completed:" + status)
    stage_stats = {}
    for stage in STAGES:
        relevant = [s for s in spans.values() if s["stage"] == stage]
        stage_stats[stage] = {kind: interval_stats([(s["start"]["monotonicNs"], (s["finish"] or end)["monotonicNs"]) for s in relevant if s["kind"] == kind]) for kind in KINDS}
        stage_stats[stage]["workConcurrency"] = interval_stats([(s["start"]["monotonicNs"], (s["finish"] or end)["monotonicNs"]) for s in relevant if s["kind"] != "waiting"])["maxConcurrentSpans"]
        stage_stats[stage]["spanCount"] = len(relevant)
    return {"schemaVersion": 1, "runId": initial["runId"], "status": status,
            "source": initial["source"], "skillTreeSha256": initial["skillTree"]["sha256"],
            "runtime": initial["runtime"], "scope": initial["scope"], "scopeHash": initial["scopeHash"],
            "config": initial["config"], "comparisonConfigHash": initial["comparisonConfigHash"],
            "requested": initial["requested"], "actualModel": initial["actualModel"],
            "cleanStartAudit": initial["cleanStartAudit"], "startedAt": events[0]["time"],
            "endedAt" if terminal else "observedAt": end,
            "elapsedSeconds": (end["monotonicNs"] - events[0]["time"]["monotonicNs"]) / 1e9,
            "elapsedDefinition": "init to terminal completion (or current observation), including waiting and uninstrumented gaps; never the sum of overlapping stages",
            "stageTimings": stage_stats, "spans": list(spans.values()),
            "fullCompletedEligible": not issues, "limitations": issues,
            "qualityEvidence": quality, "finalEventHash": events[-1]["eventHash"],
            "integrityNote": "Append-only API and hash chain detect accidental changes; not an externally signed or tamper-proof audit.",
            "timingNote": "Observed span concurrency is instrumentation, not proof of actual model worker count; monotonic continuity conservatively checks host, clock implementation and estimated boot origin within 5 seconds."}


def compare_runs(current, baseline):
    reasons = []
    for label, report in (("current", current), ("baseline", baseline)):
        if not report["fullCompletedEligible"]:
            reasons.append(label + "-not-full-completed")
    for key in ("scopeHash", "comparisonConfigHash"):
        if current[key] != baseline[key]:
            reasons.append("different-" + key)
    if any(current["source"][key] != baseline["source"][key] for key in ("sha256", "bytes")):
        reasons.append("different-source")
    if current["runtime"] != baseline["runtime"]:
        reasons.append("different-host-or-runtime")
    if current["runId"] == baseline["runId"]:
        reasons.append("same-run")
    if min(current["elapsedSeconds"], baseline["elapsedSeconds"]) <= 0:
        reasons.append("nonpositive-duration")
    result = {"status": "blocked" if reasons else "comparable-observation", "reasons": reasons,
              "currentRunId": current["runId"], "baselineRunId": baseline["runId"],
              "currentSkillTreeSha256": current["skillTreeSha256"], "baselineSkillTreeSha256": baseline["skillTreeSha256"],
              "actualModelEqualityVerified": False,
              "caveat": "Requested configuration is comparable; actual backend model/reasoning/service tier are unknown. One observed pair is not a controlled performance estimate. Different skill tree hashes are intentional version variables, not hidden equivalents."}
    if not reasons:
        result.update({"observedSpeedupRatio": baseline["elapsedSeconds"] / current["elapsedSeconds"],
                       "ratioDefinition": "baseline end-to-end seconds / current end-to-end seconds",
                       "currentElapsedSeconds": current["elapsedSeconds"], "baselineElapsedSeconds": baseline["elapsedSeconds"]})
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init")
    init.add_argument("work")
    init.add_argument("--source", required=True)
    init.add_argument("--skill-root", required=True)
    init.add_argument("--config", required=True, help="JSON object of comparable settings; exclude deliberate skill version labels")
    init.add_argument("--scope")
    init.add_argument("--requested-model")
    init.add_argument("--requested-thinking")
    init.add_argument("--requested-service-tier")
    init.add_argument("--requested-max-workers", type=int, default=1)
    start = sub.add_parser("start")
    start.add_argument("work")
    start.add_argument("stage", choices=STAGES)
    start.add_argument("--kind", choices=KINDS, default="active")
    start.add_argument("--label", default="")
    start.add_argument("--run", action="store_true", help="Execute command after -- without a shell, then record actual exit")
    start.add_argument("--evidence", action="append", default=[])
    finish = sub.add_parser("finish")
    finish.add_argument("work")
    finish.add_argument("span_id")
    finish.add_argument("--status", choices=("completed", "failed", "blocked"), default="completed")
    finish.add_argument("--evidence", action="append", default=[])
    finish.add_argument("--note", default="")
    finish.add_argument("--resolves", action="append", default=[])
    complete = sub.add_parser("complete")
    complete.add_argument("work")
    complete.add_argument("--status", choices=("completed", "partial", "blocked"), default="completed")
    complete.add_argument("--quality-evidence")
    complete.add_argument("--note", default="")
    report = sub.add_parser("report")
    report.add_argument("work")
    report.add_argument("--compare")
    for command in (start, finish, complete):
        command.add_argument("--lock-timeout", type=float, default=10)
    arguments = list(sys.argv[1:] if argv is None else argv)
    command = []
    if "--" in arguments:
        split = arguments.index("--")
        arguments, command = arguments[:split], arguments[split + 1:]
    args = parser.parse_args(arguments)
    try:
        if command and (args.action != "start" or not args.run):
            raise ValueError("A subprocess command is only valid with start --run -- COMMAND")
        if args.action == "init":
            result = init_run(args.work, args.source, args.skill_root, read_json(args.config),
                              read_json(args.scope) if args.scope else None, args.requested_model,
                              args.requested_thinking, args.requested_service_tier, args.requested_max_workers)
        elif args.action == "start":
            if args.run and not command:
                raise ValueError("--run requires -- COMMAND")
            if args.evidence and not args.run:
                raise ValueError("--evidence belongs to finish unless executing --run")
            result = start_span(args.work, args.stage, args.kind, args.label, command, args.lock_timeout)
            if args.run:
                try:
                    # Output is inherited onto stderr so stdout remains JSON.
                    process = subprocess.run(command, stdout=sys.stderr, stderr=sys.stderr, check=False)
                    code, note = process.returncode, "Actual subprocess exit recorded."
                except OSError as error:
                    code, note = 127, "Subprocess launch failed: " + str(error)
                except KeyboardInterrupt:
                    code, note = 130, "Subprocess interrupted by operator."
                result = finish_span(args.work, result["spanId"], "completed" if code == 0 else "failed",
                                     args.evidence if code == 0 else (), note, exit_code=code, lock_timeout=args.lock_timeout)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if code == 0 else 1
        elif args.action == "finish":
            result = finish_span(args.work, args.span_id, args.status, args.evidence, args.note, args.resolves, lock_timeout=args.lock_timeout)
        elif args.action == "complete":
            result = complete_run(args.work, args.status, args.quality_evidence, args.note, args.lock_timeout)
        else:
            result = report_run(args.work)
            if args.compare:
                result["comparison"] = compare_runs(result, report_run(args.compare))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "blocked", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
