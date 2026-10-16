"""Shared identities for source preparation and independent translation jobs."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

_held = threading.local()


@contextmanager
def work_lock(work, operation="write", timeout=10):
    """One writer per article, including the legacy command entry points.

    Reentrant only in the same thread/process. Never guesses that an old lock
    is abandoned; recovery is an explicit, separately checked operation.
    """
    work = Path(work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    lock = work / ".micro-paper-write.lock"
    held = getattr(_held, "paths", {})
    key = (os.getpid(), str(lock))
    if key in held:
        yield
        return
    deadline = time.monotonic() + max(0, timeout)
    token = uuid.uuid4().hex
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise ValueError("Article writer lock is held; retry after the writer finishes or explicitly recover a verified dead writer: " + str(lock))
            time.sleep(min(.05, max(0, deadline - time.monotonic())))
    owner = {"pid": os.getpid(), "operation": operation,
             "createdAt": datetime.now(timezone.utc).isoformat(),
             "hostname": socket.gethostname(), "token": token}
    try:
        (lock / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
        held[key] = token
        _held.paths = held
        if (work / ".source-transaction").exists() and operation != "source-recover":
            raise ValueError("Unfinished source transaction; preserve its journal and recover the verified source state before any other write")
        if (work / ".translation-transaction").exists() and operation != "translation-recover":
            raise ValueError("Unfinished translation transaction; run translation_pipeline.py recover before any other write")
        yield
    finally:
        held.pop(key, None)
        try:
            current = json.loads((lock / "owner.json").read_text(encoding="utf-8"))
            if current.get("token") == token:
                shutil.rmtree(lock)
        except (OSError, ValueError):
            pass


def locked_work(function):
    @wraps(function)
    def guarded(work, *args, **kwargs):
        with work_lock(work, function.__name__):
            if (Path(work) / ".translation-transaction").exists():
                raise ValueError("Unfinished translation transaction; run translation_pipeline.py recover before any other write")
            return function(work, *args, **kwargs)
    return guarded


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def structure_fingerprint(paper):
    """Bind translation's English source and context without binding its output.

    Bibliography link annotations do not alter source words or translation
    context. Their evidence has a separate audit; adding them cannot invalidate
    an otherwise identical translation. Figure/caption associations do affect
    translation context and are included.
    """
    metadata = {k: v for k, v in paper.get("metadata", {}).items()
                if k not in {"titleZh", "translatedTitle", "translation"}}
    block_keys = ("blockId", "order", "kind", "en", "enHash", "sourceSpans",
                  "exclusionReason", "candidateColumn", "bbox")
    section_keys = ("sectionId", "titleEn", "blockIds")
    return digest({
        "documentId": paper.get("documentId"),
        "sourceSha256": paper.get("sourceSha256"),
        **({"sourceTranscriptionLedgerSha256": paper["sourceTranscriptionLedgerSha256"]}
           if "sourceTranscriptionLedgerSha256" in paper else {}),
        "metadata": metadata,
        "pages": [{k: v for k, v in p.items() if k != "asset"}
                  for p in paper.get("pages", [])],
        "blocks": [{k: b[k] for k in block_keys if k in b}
                   for b in paper.get("blocks", [])],
        "sections": [{k: s[k] for k in section_keys if k in s}
                     for s in paper.get("sections", [])],
        "figures": [{k: v for k, v in f.items() if k != "asset"}
                    for f in paper.get("figures", [])],
        "formatting": [f for f in paper.get("formatting", [])
                       if f.get("language") == "en"],
        "inlineReferences": [r for r in paper.get("inlineReferences", [])
                             if r.get("language") == "en"],
        "idMap": [m for m in paper.get("idMap", [])
                  if m.get("language") == "en"],
        "sourceEdits": paper.get("sourceEdits", []),
    })
