#!/usr/bin/env python3
"""Run a reviewed batch of guarded R760 control writes with one backup.

Each entry of the batch file is {"phase": "<label>", "args": [<admin CLI args>]}
and retains the wrapper's allowlist and operation-specific checks. By default
the frozen, fail-fast batch shares one verified backup and one final integrity
check. Interrupted shared batches require state reconciliation, not blind replay.
Use --backup-per-step for historical resumable or global quota operations.

    python scripts/run-r760-control-batch.py --batch .tmp/ops-batch-2026-09-17.json --what-if
    python scripts/run-r760-control-batch.py --batch .tmp/ops-batch-2026-09-17.json
    python scripts/run-r760-control-batch.py --batch ... --backup-per-step --phase 1-disable --resume
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

WRAPPER = Path(__file__).with_name("manage-r760-gateway-control.py")


def load_control():
    spec = importlib.util.spec_from_file_location("r760_control", WRAPPER)
    control = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(control)
    return control


def run_shared(args, steps, log_path: Path) -> int:
    """Use an in-memory backup capability; no persisted 'skip backup' token."""
    control = load_control()
    if args.resume or args.continue_on_error:
        raise ValueError("Shared batches stop on failure and require state reconciliation; these flags require --backup-per-step.")
    if not args.what_if and log_path.exists() and log_path.stat().st_size:
        raise ValueError("Existing batch log: reconcile committed/unknown steps before preparing a new batch and log.")
    parsed = []
    for step in steps:
        if not isinstance(step, dict) or not isinstance(step.get("args"), list) or not all(
            isinstance(value, str) for value in step["args"]
        ):
            raise ValueError("Each step requires a string args array.")
        control.validate_admin_args(step["args"])
        parsed.append(control.parse_args(["--timeout-seconds", str(args.timeout_seconds),
            *(["--what-if"] if args.what_if else []), "--", *step["args"]]))
    if not parsed:
        print("No selected steps; no backup or writes.")
        return 0
    batch_args = control.parse_args(["--timeout-seconds", str(args.timeout_seconds),
        "--", *parsed[0].admin_args])
    batch = control.VerifiedControlBatch(batch_args, [item.admin_args for item in parsed])
    if args.what_if:
        for item in parsed:
            print(json.dumps(control.execute(item), ensure_ascii=False))
        return 0
    fingerprint = hashlib.sha256(json.dumps(steps, sort_keys=True).encode()).hexdigest()
    def record(log, value):
        value = {"at":datetime.now(timezone.utc).isoformat(), "batch_sha256":fingerprint, **value}
        log.write(control.redact_secrets(json.dumps(value, ensure_ascii=False)) + "\n")
        log.flush()
        os.fsync(log.fileno())
    with log_path.open("x", encoding="utf-8") as log:
        record(log, {"event":"batch_start", "steps":steps})
        print(f"Preparing one verified backup for {len(parsed)} steps.", flush=True)
        try:
            with batch:
                record(log, {"event":"backup_verified", "backup":batch.backup})
                for index, item in enumerate(parsed):
                    record(log, {"event":"step_started", "index":index})
                    result = control.execute(item, batch=batch)
                    record(log, {"event":"step_committed", "index":index, "result":result})
                    print(f"[applied {index + 1}/{len(parsed)}] {steps[index].get('phase', '')}; final integrity pending", flush=True)
            record(log, {"event":"batch_verified", "integrity_after":batch.after})
            print(f"done steps={len(parsed)} backups=1 integrity=ok", flush=True)
            return 0
        except BaseException as exc:
            record(log, {"event":"batch_failed", "error":str(exc), "integrity_after":batch.after})
            raise


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--batch", required=True, help="JSON list of {phase, args}")
    parser.add_argument("--log", help="JSONL progress log (default: <batch>.log.jsonl)")
    parser.add_argument("--phase", action="append", help="only run these phase labels (repeatable)")
    parser.add_argument("--what-if", action="store_true", help="pass --what-if to every wrapper call (no remote writes)")
    parser.add_argument("--resume", action="store_true", help="skip steps already logged as ok")
    parser.add_argument("--backup-per-step", action="store_true", help="legacy per-step backup/resume mode; required for global quota rewrites")
    parser.add_argument("--continue-on-error", action="store_true", help="keep going after a failed step")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    args = parser.parse_args()

    batch_path = Path(args.batch)
    steps = json.loads(batch_path.read_text(encoding="utf-8"))
    if not isinstance(steps, list):
        parser.error("Batch must be a JSON list.")
    log_path = Path(args.log) if args.log else batch_path.with_suffix(".log.jsonl")
    if not args.backup_per_step:
        selected_steps = [step for step in steps if not args.phase or step.get("phase") in args.phase]
        try:
            return run_shared(args, selected_steps, log_path)
        except Exception as exc:
            from codex_gateway_ops_common import redact_secrets
            print(redact_secrets(str(exc)), file=sys.stderr)
            return 1
    done: set[str] = set()
    if args.resume and log_path.exists():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("ok") and not rec.get("what_if"):
                done.add(rec["key"])

    selected = [(i, s) for i, s in enumerate(steps) if not args.phase or s.get("phase") in args.phase]
    print(f"batch={batch_path} steps={len(selected)} what_if={args.what_if} log={log_path}")
    ok = skipped = failed = 0
    with log_path.open("a", encoding="utf-8") as log:
        for index, step in selected:
            key = f"{index}:{' '.join(step['args'])}"
            if key in done:
                skipped += 1
                continue
            cmd = [sys.executable, str(WRAPPER), "--timeout-seconds", str(args.timeout_seconds)]
            if args.what_if:
                cmd.append("--what-if")
            cmd += ["--", *step["args"]]
            started = time.monotonic()
            env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
            elapsed = round(time.monotonic() - started, 1)
            success = proc.returncode == 0
            record = {
                "at": datetime.now(timezone.utc).isoformat(), "key": key, "phase": step.get("phase"),
                "args": step["args"], "what_if": args.what_if, "ok": success, "exit": proc.returncode,
                "seconds": elapsed, "stdout": proc.stdout[-4000:], "stderr": proc.stderr[-2000:],
            }
            log.write(json.dumps(record, ensure_ascii=False) + "\n")
            log.flush()
            label = " ".join(step["args"][:4])
            if success:
                ok += 1
                print(f"[ok  {index + 1}/{len(steps)}] {step.get('phase')} {label} ({elapsed}s)")
            else:
                failed += 1
                print(f"[FAIL {index + 1}/{len(steps)}] {step.get('phase')} {label} exit={proc.returncode}")
                print((proc.stderr or proc.stdout)[-1500:])
                if not args.continue_on_error:
                    break
    print(f"done ok={ok} skipped={skipped} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
