"""Prepare the authorized text-route upgrade and dual-provider long-model pool.

Preserves vision routes, limits, deadlines, other models and unrelated env lines.
Writes only a protected candidate. Activation requires the normal Gateway drain,
recreation, public verification and configuration rollback procedure.
"""
import argparse
import copy
import json
import os
from pathlib import Path

REGISTRY = "MEDCODE_PUBLIC_MODELS_JSON"
VERSION = "deepseek-v4.1-flash-1017"
LONG = "goldencode-d-long"


def prepare_env(original, fragment):
    if set(fragment) != {LONG}:
        raise ValueError("Expected long-model fragment only")
    lines = original.decode("utf-8").splitlines(keepends=True)
    if any(line.startswith(REGISTRY + "_FILE=") and line.split("=", 1)[1].strip().strip("'\"") for line in lines):
        raise ValueError("File-backed registry requires separate preparation")
    indices = [i for i, line in enumerate(lines) if line.startswith(REGISTRY + "=")]
    if len(indices) != 1:
        raise ValueError("Expected one inline registry")
    index = indices[0]
    raw = lines[index].split("=", 1)[1].strip()
    if raw[:1] in ("'", '"') and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    registry = json.loads(raw)
    before = copy.deepcopy(registry)
    members = registry["goldencode-d"]["pool"]["members"]
    if len(members) != 2 or {m["runtime"] for m in members} != {"tencent", "tiankuan"}:
        raise ValueError("Unexpected existing DeepSeek pool")
    for member in members:
        accepted = {VERSION} if member["runtime"] == "tencent" else {VERSION, "deepseek-v4.1-flash"}
        if member["upstreamModel"] not in accepted:
            raise ValueError("Unexpected existing DeepSeek version")
        member["upstreamModel"] = VERSION
    target = fragment[LONG]
    old = registry[LONG]
    if old != target:
        expected = copy.deepcopy(target)
        del expected["pool"]
        expected.update(runtime="tencent", upstreamModel=VERSION)
        if old != expected:
            raise ValueError("Existing long-model configuration changed")
        registry[LONG] = target
    if registry == before:
        return original, False
    ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
    lines[index] = REGISTRY + "=" + json.dumps(registry, ensure_ascii=True, separators=(",", ":")) + ending
    return "".join(lines).encode("utf-8"), True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--fragment", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    candidate, changed = prepare_env(args.env_file.read_bytes(), json.loads(args.fragment.read_text(encoding="utf-8")))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(candidate)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps({"changed": changed, "activated": False}))
