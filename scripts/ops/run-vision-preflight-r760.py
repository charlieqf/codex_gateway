"""Run the prepared R760 vision candidate in an isolated, bounded container.

Usage: python3 -B run-vision-preflight-r760.py <full-release-revision>
See docs/operations/cloud-vision-rollout.md. No production DB mounts or writes.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import uuid


def inspect(name):
    return json.loads(subprocess.check_output(["docker", "inspect", name]))[0]


def provider_file_mounts(meta):
    env = dict(value.split("=", 1) for value in meta["Config"]["Env"])
    prefixes = ("MEDCODE_VISION_XAI_", "MEDCODE_TENCENT_", "MEDCODE_TIANKUAN_")
    required = {value for key, value in env.items() if value and key.endswith("_FILE") and
                (key.startswith(prefixes) or key == "MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE")}
    for key, value in env.items():
        if key.startswith(prefixes) and key.endswith("_API_KEY_ENV") and env.get(value.strip() + "_FILE"):
            required.add(env[value.strip() + "_FILE"])
    if env.get("NODE_EXTRA_CA_CERTS"):
        required.add(env["NODE_EXTRA_CA_CERTS"])
    mounts = {}
    for destination in required:
        for mount in sorted(meta["Mounts"], key=lambda item: len(item["Destination"]), reverse=True):
            base = mount["Destination"]
            if destination == base or destination.startswith(base + "/"):
                source = pathlib.Path(mount["Source"]) / pathlib.PurePosixPath(destination).relative_to(base)
                if not source.is_file():
                    raise RuntimeError("Required provider file is missing; candidate not started")
                mounts[destination] = str(source)
                break
        else:
            raise RuntimeError("Provider file is not backed by a known mount; map it explicitly before preflight")
    return mounts


def main():
    revision = sys.argv[1]
    assert re.fullmatch(r"[0-9a-f]{40}", revision)
    os.umask(0o077)
    root = pathlib.Path("/opt/codex-gateway-r760")
    backup = root / "backups" / ("release-" + revision[:12])
    stage = root / "staging" / revision
    candidate = backup / "vision-candidate.env"
    assert candidate.is_file() and candidate.stat().st_mode & 0o777 == 0o600
    state = json.loads((backup / "deployment.json").read_text())
    live = inspect("codex_gateway_r760-gateway-1")
    assert live["Id"] == state["old_container_id"] and state["revision"] == revision
    image = inspect("codex_gateway_r760-gateway:" + revision)
    assert image["Config"]["Labels"]["org.opencontainers.image.revision"] == revision
    candidate_hash = hashlib.sha256(candidate.read_bytes()).hexdigest()
    name = "vision-preflight-" + uuid.uuid4().hex
    args = ["docker", "run", "--rm", "--name", name, "--user", "root", "--network", "container:" + live["Id"],
            "--entrypoint", "node", "-v", str(candidate) + ":/run/vision-candidate.env:ro"]
    for destination, source in provider_file_mounts(live).items():
        args += ["-v", source + ":" + destination + ":ro"]
    live_env = dict(value.split("=", 1) for value in live["Config"]["Env"])
    # Node 24 does not activate env proxying when NODE_USE_ENV_PROXY is loaded
    # only through --env-file. Match the live process's startup setting explicitly.
    proxy_args = ["--use-env-proxy"] if live_env.get("NODE_USE_ENV_PROXY") == "1" else []
    args += [image["Id"], *proxy_args, "--env-file=/run/vision-candidate.env",
             "/app/scripts/ops/deepseek-vision-preflight.mjs", "--responses-control"]
    result = {"revision": revision, "image_id": image["Id"], "candidate_sha256": candidate_hash,
              "preflight_rc": None}
    try:
        with (stage / "vision-preflight.log").open("w") as log:
            returncode = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=180).returncode
        assert hashlib.sha256(candidate.read_bytes()).hexdigest() == candidate_hash, "Candidate changed during preflight"
        result["preflight_rc"] = returncode
    finally:
        # Exact task-owned random name; also cleans up a timed-out docker client.
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15)
        (stage / "preflight-proof.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    raise SystemExit(result["preflight_rc"])


if __name__ == "__main__":
    main()
