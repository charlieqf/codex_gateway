"""Prepare the existing DeepSeek ID's larger text window and remove the unused long ID.

Only the three text context fields, retired model and its deadline are changed.
Vision, provider pools, output limits and all unrelated configuration are retained.
"""
import argparse
import json
import os
from pathlib import Path

REGISTRY = "MEDCODE_PUBLIC_MODELS_JSON"
TIMEOUTS = "MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON"
RETIRED = "goldencode-d-long"


def prepare_env(original, limits):
    if limits != dict.fromkeys(("contextWindow", "maxContextWindow", "upstreamContextWindow"), 1024000):
        raise ValueError("Unexpected text context limits")
    lines = original.decode("utf-8").splitlines(keepends=True)
    if any(line.startswith(REGISTRY + "_FILE=") and line.split("=", 1)[1].strip().strip("'\"") for line in lines):
        raise ValueError("File-backed registry requires separate preparation")

    def read(key):
        indices = [i for i, line in enumerate(lines) if line.startswith(key + "=")]
        if len(indices) != 1:
            raise ValueError("Expected exactly one inline " + key)
        raw = lines[indices[0]].split("=", 1)[1].strip()
        if raw[:1] in ("'", '"') and raw[-1:] == raw[:1]:
            raw = raw[1:-1]
        return indices[0], json.loads(raw)

    ri, registry = read(REGISTRY)
    ti, timeouts = read(TIMEOUTS)
    model = registry["goldencode-d"]
    if model["runtime"] != "pool" or model["maxOutputTokens"] != 128000:
        raise ValueError("Unexpected DeepSeek model")
    members = model["pool"]["members"]
    if len(members) != 2 or {m["runtime"] for m in members} != {"tencent", "tiankuan"} or any(
        m["upstreamModel"] != "deepseek-v4.1-flash-1017" for m in members
    ):
        raise ValueError("Expected the verified dual 1017 pool")
    if model["contextWindow"] not in (200000, 1024000) or model["maxContextWindow"] not in (200000, 1024000):
        raise ValueError("Text context changed since review")
    if timeouts["models"]["goldencode-d"] != 1800000:
        raise ValueError("Unexpected existing deadline")
    changed = any(model[k] != v for k, v in limits.items()) or RETIRED in registry or RETIRED in timeouts["models"]
    if not changed:
        return original, False
    model.update(limits)
    registry.pop(RETIRED, None)
    timeouts["models"].pop(RETIRED, None)
    for index, key, value in ((ri, REGISTRY, registry), (ti, TIMEOUTS, timeouts)):
        ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
        lines[index] = key + "=" + json.dumps(value, ensure_ascii=True, separators=(",", ":")) + ending
    return "".join(lines).encode("utf-8"), True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--limits", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    candidate, changed = prepare_env(args.env_file.read_bytes(), json.loads(args.limits.read_text(encoding="utf-8")))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(candidate)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps({"changed": changed, "activated": False}))
