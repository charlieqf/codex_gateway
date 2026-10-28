"""Prepare, but never activate, the R760 DeepSeek vision configuration.

Copy the live goldencode vision configuration exactly to goldencode-d. Public
tier adaptation belongs to the Gateway reasoning policy. The source
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
import tempfile


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
        write_candidate(args.output, proposed)
    print(json.dumps({"changed": changed, "changed_field": "goldencode-d.vision" if changed else None,
                      "source_sha256": hashlib.sha256(original).hexdigest(),
                      "proposed_sha256": hashlib.sha256(proposed).hexdigest(),
                      "candidate_written": args.output is not None, "activated": False}))


def write_candidate(path, contents):
    # Publish a complete, fsynced candidate atomically without replacing an
    # existing file. A hard link gives no-replace semantics on Linux and Windows.
    fd, temporary = tempfile.mkstemp(prefix=".vision-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


if __name__ == "__main__":
    main()
