"""Run on the Docker host before a controlled Gateway replacement.

Rejects old runtimes before sending signals. Holds admission closed after a
successful drain; run --resume if cancelling the deployment. Does not deploy.
"""
import argparse
import json
import subprocess
import time


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=15).stdout


def status(container):
    source = "fetch('http://127.0.0.1:8787/gateway/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()).then(v=>console.log(JSON.stringify(v.lifecycle))).catch(()=>process.exit(1))"
    result = json.loads(run(["docker", "exec", container, "node", "-e", source]))
    if not isinstance(result, dict) or not isinstance(result.get("draining"), bool):
        raise RuntimeError("Runtime has no drain protocol; signal was not sent")
    for key in ("active_requests", "active_work"):
        if type(result.get(key)) is not int or result[key] < 0:
            raise RuntimeError("Invalid lifecycle counters")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="codex_gateway_r760-gateway-1")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    meta = json.loads(run(["docker", "inspect", "--format", '{"id":{{json .Id}},"command":{{json .Config.Cmd}}}', args.container]))
    container = meta["id"]  # Pin the inspected instance across a concurrent replacement.
    if meta["command"] != ["node", "/app/apps/gateway/dist/index.js"]:
        raise RuntimeError("Unexpected process entrypoint; verify signal forwarding before drain")
    status(container)  # Never send USR signals to an unsupported Node process.
    run(["docker", "kill", "--signal=" + ("SIGCONT" if args.resume else "SIGUSR2"), container])
    until = time.monotonic() + args.timeout
    while time.monotonic() < until:
        current = status(container)
        if args.resume and not current["draining"]:
            print(json.dumps(current))
            return
        if not args.resume and current["draining"] and current["active_requests"] == current["active_work"] == 0:
            print(json.dumps(current))
            return
        time.sleep(1)
    raise RuntimeError("Drain state did not converge; no deployment performed. Inspect work before resuming or retrying.")


if __name__ == "__main__":
    main()
