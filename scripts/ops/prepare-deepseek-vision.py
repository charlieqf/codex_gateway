"""Prepare, but never activate, the R760 DeepSeek vision configuration.

Copy the live goldencode vision configuration to goldencode-d, with the cloud
max tier mapped to vision high when max is not natively supported. The source
env file is never modified. With no --output this is a read-only dry run; an output
is created exclusively with mode 0600 and contains credentials from the source.
Do not print, commit, or upload that file. Deployment still requires the normal
backup, controlled Gateway recreation and public verification procedure.
"""
import argparse
import copy
import hashlib
import json
import os
import pathlib


REGISTRY_KEY = "MEDCODE_PUBLIC_MODELS_JSON"


def prepare_env(original):
    lines = original.decode("utf-8").splitlines(keepends=True)
    entries = [i for i, line in enumerate(lines) if line.startswith(REGISTRY_KEY + "=")]
    if len(entries) != 1:
        raise ValueError("Expected exactly one inline public model registry")
    for line in lines:
        if line.startswith(REGISTRY_KEY + "_FILE=") and line.split("=", 1)[1].strip().strip("'\""):
            raise ValueError("A file-backed registry requires a separate migration")
    index = entries[0]
    raw = lines[index].split("=", 1)[1].strip()
    if raw[:1] in ("'", '"') and raw[-1:] == raw[:1]:
        raw = raw[1:-1]
    registry = json.loads(raw)
    if not isinstance(registry, dict):
        raise ValueError("Expected an object registry")
    source, target = registry.get("goldencode"), registry.get("goldencode-d")
    if not isinstance(source, dict) or not isinstance(target, dict):
        raise ValueError("Both cloud models must already exist")
    if source.get("enabled", True) is not True or target.get("enabled", True) is not True:
        raise ValueError("Both cloud models must be enabled")
    vision = copy.deepcopy(source.get("vision"))
    if not isinstance(vision, dict) or vision.get("runtime") != "xai" or vision.get("enabled", True) is not True:
        raise ValueError("The source must have an enabled xAI vision route")
    if not isinstance(vision.get("upstreamModel"), str) or not vision["upstreamModel"].strip():
        raise ValueError("The source vision model is missing")
    for key in ("contextWindow", "maxOutputTokens"):
        if type(vision.get(key)) is not int or vision[key] <= 0:
            raise ValueError("The source vision limits must be positive integers")
    reasoning = vision.setdefault("reasoning", {})
    if not isinstance(reasoning, dict):
        raise ValueError("Expected a vision reasoning object")
    supported = reasoning.setdefault("supportedEfforts", ["none", "low", "medium", "high"])
    if "max" not in supported:
        if "high" not in supported:
            raise ValueError("The source vision route cannot map the cloud max tier to high")
        aliases = reasoning.setdefault("legacyAliases", {})
        if not isinstance(aliases, dict) or aliases.get("max", "high") != "high":
            raise ValueError("Conflicting vision max reasoning mapping")
        aliases["max"] = "high"
    if target.get("vision") == vision:
        return original, False
    if target.get("vision") is not None:
        raise ValueError("Refusing to overwrite a different explicit DeepSeek vision route")
    proposed = copy.deepcopy(registry)
    proposed["goldencode-d"]["vision"] = copy.deepcopy(vision)
    ending = "\r\n" if lines[index].endswith("\r\n") else "\n" if lines[index].endswith("\n") else ""
    lines[index] = REGISTRY_KEY + "=" + json.dumps(proposed, ensure_ascii=True, separators=(",", ":")) + ending
    return "".join(lines).encode("utf-8"), True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    original = args.env_file.read_bytes()
    try:
        proposed, changed = prepare_env(original)
    except (ValueError, TypeError, KeyError):
        # JSON parse errors may include secret-bearing input; never emit them.
        parser.exit(1, "Registry validation failed; source unchanged.\n")
    if args.output:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(proposed)
    print(json.dumps({"changed": changed, "changed_field": "goldencode-d.vision" if changed else None,
                      "source_sha256": hashlib.sha256(original).hexdigest(),
                      "proposed_sha256": hashlib.sha256(proposed).hexdigest(),
                      "candidate_written": args.output is not None, "activated": False}))


if __name__ == "__main__":
    main()
