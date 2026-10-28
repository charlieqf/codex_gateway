"""Run on the Docker host before a controlled Gateway replacement.

Rejects old runtimes before sending signals. Holds admission closed after a
successful drain; run --resume if cancelling the deployment. Does not deploy.
"""
import argparse
import json
import subprocess
import sys
import time
from gateway_release_idle import validate_lifecycle, wait_for_natural_idle


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout


def status(container):
    source = "fetch('http://127.0.0.1:8787/gateway/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(v=>console.log(JSON.stringify(v.lifecycle))).catch(()=>process.exit(1))"
    return validate_lifecycle(json.loads(run(["docker", "exec", container, "node", "-e", source])))


def await_state(container, timeout, resume):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        current = status(container)
        if resume and not current["draining"]:
            return current
        if not resume and current["draining"] and current["active_requests"] == current["active_work"] == 0:
            return current
        time.sleep(min(1, max(0, until - time.monotonic())))
    raise RuntimeError("Drain state did not converge; no deployment performed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="codex_gateway_r760-gateway-1")
    parser.add_argument("--timeout", type=int, default=30, help="Drain/resume polling seconds (capped at 30)")
    parser.add_argument("--idle-timeout", type=int, default=900, help="Wait for natural idle with admission open")
    parser.add_argument("--idle-stable-seconds", type=int, choices=(5, 30), default=30,
                        help="Continuous zero-request/zero-work window; default 30, explicit short window 5")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0 or args.idle_timeout <= 30:
        parser.error("--timeout must be positive; --idle-timeout must exceed the 30-second idle window")
    timeout = min(args.timeout, 30)
    if args.timeout > timeout:
        print(f"WARNING: requested --timeout {args.timeout}s exceeds the admission safety limit; using {timeout}s.", file=sys.stderr)
    meta = json.loads(run(["docker", "inspect", "--format", '{"id":{{json .Id}},"command":{{json .Config.Cmd}}}', args.container]))
    container = meta["id"]  # Pin the inspected instance across a concurrent replacement.
    if meta["command"] != ["node", "/app/apps/gateway/dist/index.js"]:
        raise RuntimeError("Unexpected process entrypoint; verify signal forwarding before drain")
    status(container)  # Never send USR signals to an unsupported Node process.
    if args.resume:
        run(["docker", "kill", "--signal=SIGCONT", container])
        print(json.dumps(await_state(container, timeout, True)))
        return
    # All callers, including the generic cutover script, get the same gate.
    # This check fails without sending any signal if traffic never goes idle.
    wait_for_natural_idle(lambda: status(container), timeout=args.idle_timeout,
                          stable_seconds=args.idle_stable_seconds, monotonic=time.monotonic, sleep=time.sleep)
    try:
        run(["docker", "kill", "--signal=SIGUSR2", container])
        print(json.dumps(await_state(container, timeout, False)))
    except (Exception, KeyboardInterrupt):
        try:
            run(["docker", "kill", "--signal=SIGCONT", container])
            await_state(container, 30, True)
        except Exception as recovery_error:
            raise RuntimeError("Drain aborted; could not verify recovery of the old Gateway admission") from recovery_error
        raise


if __name__ == "__main__":
    main()
