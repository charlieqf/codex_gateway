#!/usr/bin/env python3
"""Run a reviewed batch of guarded R760 control writes, one wrapper call each.

Each entry of the batch file is {"phase": "<label>", "args": [<admin CLI args>]}
and is executed as `manage-r760-gateway-control.py -- <args>`, so every step
still gets the wrapper's allowlist check, verified pre-write backup and
integrity validation. Progress is appended to a JSONL log so an interrupted run
can be resumed with --resume (already-succeeded steps are skipped).

    python scripts/run-r760-control-batch.py --batch .tmp/ops-batch-2026-09-17.json --what-if
    python scripts/run-r760-control-batch.py --batch .tmp/ops-batch-2026-09-17.json
    python scripts/run-r760-control-batch.py --batch ... --phase 1-disable --resume
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

WRAPPER = Path(__file__).with_name("manage-r760-gateway-control.py")


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
    parser.add_argument("--continue-on-error", action="store_true", help="keep going after a failed step")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    args = parser.parse_args()

    batch_path = Path(args.batch)
    steps = json.loads(batch_path.read_text(encoding="utf-8"))
    log_path = Path(args.log) if args.log else batch_path.with_suffix(".log.jsonl")
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
