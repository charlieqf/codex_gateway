"""Prepare a protected long-document model config; never change the live file.

Merge the committed model fragment into the live registry, preserving existing
models and all unrelated env lines. Deployment reuses the live image and needs
the standard idle/drain, Gateway recreation and public verification procedure.
"""
import argparse
import json
import os
from pathlib import Path


MODEL = "goldencode-d-long"
REGISTRY = "MEDCODE_PUBLIC_MODELS_JSON"
TIMEOUTS = "MEDCODE_CHAT_REQUEST_TIMEOUTS_JSON"


def prepare_env(original, fragment):
    if set(fragment) != {MODEL}:
        raise ValueError("Expected only the long-document model")
    lines = original.decode("utf-8").splitlines(keepends=True)
    for line in lines:
        if line.startswith(REGISTRY + "_FILE=") and line.split("=", 1)[1].strip().strip("'\""):
            raise ValueError("File-backed registry requires separate preparation")

    def read(key):
        indices = [i for i, line in enumerate(lines) if line.startswith(key + "=")]
        if len(indices) != 1:
            raise ValueError("Expected exactly one inline " + key)
        raw = lines[indices[0]].split("=", 1)[1].strip()
        if raw[:1] in ("'", '"') and raw[-1:] == raw[:1]:
            raw = raw[1:-1]
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Expected object: " + key)
        return indices[0], value

    registry_index, registry = read(REGISTRY)
    timeout_index, timeouts = read(TIMEOUTS)
    if "goldencode-d" not in registry:
        raise ValueError("Existing DeepSeek route is required")
    if MODEL in registry and registry[MODEL] != fragment[MODEL]:
        raise ValueError("Refusing to overwrite a different long-document model")
    models = timeouts.setdefault("models", {})
    if models.get("goldencode-d") != 1800000:
        raise ValueError("Expected verified 30-minute DeepSeek deadline")
    if MODEL in models and models[MODEL] != 1800000:
        raise ValueError("Refusing to overwrite a different model deadline")
    if MODEL in registry and MODEL in models:
        return original, False
    registry.update(fragment)
    models[MODEL] = 1800000
    for index, key, value in ((registry_index, REGISTRY, registry), (timeout_index, TIMEOUTS, timeouts)):
        ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
        lines[index] = key + "=" + json.dumps(value, ensure_ascii=True, separators=(",", ":")) + ending
    return "".join(lines).encode("utf-8"), True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--fragment", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        proposed, changed = prepare_env(args.env_file.read_bytes(), json.loads(args.fragment.read_text(encoding="utf-8")))
    except (ValueError, TypeError, AttributeError):
        parser.exit(1, "Configuration validation failed; source unchanged.\n")
    if args.output:
        # Exclusive creation preserves existing candidates and mode 0600 protects secrets.
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(proposed)
                output.flush()
                os.fsync(output.fileno())
        except BaseException:
            args.output.unlink()
            raise
    print(json.dumps({"changed": changed, "model": MODEL,
                      "candidate_written": args.output is not None, "activated": False}))


if __name__ == "__main__":
    main()
