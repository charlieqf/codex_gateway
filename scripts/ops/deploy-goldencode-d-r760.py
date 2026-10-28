"""Authorized R760 release of the DeepSeek model pool after release preparation.

Usage: python3 deploy-goldencode-d-r760.py <committed-and-pushed-revision> [--enable-vision] [--idle-stable-seconds=5]
Requires the standard release-prepare backup/state, a tested image tagged with
that revision, and migration rehearsal. Changes only Gateway image + registry.
Vision requires backups/release-<rev[:12]>/vision-candidate.env from prepare,
then preflight with that file. See docs/operations/cloud-vision-rollout.md.
"""
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from gateway_release_idle import release_idle_seconds

REV = sys.argv[1]
flags = sys.argv[2:]
idle_seconds = release_idle_seconds(flags)
enable_vision = "--enable-vision" in flags
assert re.fullmatch(r"[0-9a-f]{40}", REV)
ROOT = pathlib.Path("/opt/codex-gateway-r760")
RELEASE = ROOT / "releases" / REV
BACKUP = ROOT / "backups" / ("release-" + REV[:12])
ENVFILE = ROOT / "shared/config/gateway.container.env"
OVERRIDE = ROOT / "shared/config/compose.r760.override.yml"
CONTAINER = "codex_gateway_r760-gateway-1"
IMAGE = "codex_gateway_r760-gateway:" + REV
MODEL_ENV = "MEDCODE_PUBLIC_MODELS_JSON"
os.umask(0o077)
lock = (ROOT / ".deploy.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
state = json.loads((BACKUP / "deployment.json").read_text())


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        (BACKUP / "deepseek-command-failure.log").write_text(result.stdout + result.stderr)
        raise RuntimeError("Command failed; protected backup contains diagnostics: " + str(args[:3]))
    return result.stdout


def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compose(release):
    return ["docker", "compose", "--env-file", str(release / "config/research.production.compose.env"),
            "-p", "codex_gateway_r760", "-f", str(release / "compose.azure.yml"),
            "-f", str(release / "compose.research-production.yml"), "-f", str(OVERRIDE),
            "--profile", "research-production"]


def up(release):
    run(compose(release) + ["up", "-d", "--no-deps", "--no-build", "--force-recreate",
                            "--wait", "--wait-timeout", "180", "gateway"])


def point(name, target):
    tmp = ROOT / (".deepseek-" + name)
    assert not tmp.exists() and not tmp.is_symlink()
    tmp.symlink_to(target)
    os.replace(tmp, ROOT / name)


def write_atomic(path, contents, stat):
    tmp = path.with_name(path.name + ".deepseek-tmp")
    assert not tmp.exists()
    tmp.write_bytes(contents)
    os.chmod(tmp, stat.st_mode & 0o777)
    os.chown(tmp, stat.st_uid, stat.st_gid)
    os.replace(tmp, path)


def public_ready(label):
    started = time.monotonic()
    until = started + 60
    consecutive = 0
    probes = []
    try:
        while time.monotonic() < until:
            item = {"elapsed_seconds": round(time.monotonic() - started, 3)}
            try:
                with urllib.request.urlopen("https://goldencode.instmarket.com.au:1443/gateway/health",
                                            timeout=min(5, until - time.monotonic())) as response:
                    body = json.load(response)
                    item["http"] = response.status
                    ready = body.get("state") == "ready" and body.get("lifecycle", {}).get("draining") is False
                    item["ready"] = ready
                    consecutive = consecutive + 1 if ready else 0
            except urllib.error.HTTPError as error:
                item["http"] = error.code
                consecutive = 0
                if error.code not in (502, 503, 504):
                    raise
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                item["error"] = type(error).__name__
                consecutive = 0
            finally:
                probes.append(item)
            if consecutive >= 2:
                return
            time.sleep(min(1, max(0, until - time.monotonic())))
        raise RuntimeError("Public health did not converge within 60 seconds")
    finally:
        (BACKUP / (label + "-health.json")).write_text(json.dumps(probes, indent=2))


meta = inspect(CONTAINER)
assert meta["Id"] == state["old_container_id"]
assert str((ROOT / "current").resolve()) == state["old_current"]
assert sha(OVERRIDE) == state["override_sha256"]
assert state["revision"] == REV
candidate = inspect(IMAGE)
assert candidate["Config"]["Labels"]["org.opencontainers.image.revision"] == REV
old_env = dict(value.split("=", 1) for value in meta["Config"]["Env"])
assert not old_env.get("MEDCODE_PUBLIC_MODELS_JSON_FILE"), "File registry requires separate review"
assert old_env["GATEWAY_GOLDENCODE_NATIVE_FAILOVER_MODE"] == "enforce"
assert not old_env.get("GATEWAY_GOLDENCODE_FAILOVER_SUBJECT_IDS", "").strip()
registry = json.loads(old_env[MODEL_ENV])
assert ("goldencode-d" in registry) == enable_vision and "goldencode-local" in registry
assert {m["runtime"] for m in registry["goldencode"]["pool"]["members"] if m.get("enabled", True)} == {"tencent", "tiankuan", "tokenswitch"}
env_bytes, override_bytes = ENVFILE.read_bytes(), OVERRIDE.read_bytes()
env_stat, override_stat = ENVFILE.stat(), OVERRIDE.stat()
assert env_stat.st_mode & 0o777 == 0o600
lines = env_bytes.decode().splitlines(keepends=True)
matches = [i for i, line in enumerate(lines) if line.startswith(MODEL_ENV + "=")]
assert len(matches) == 1
assert json.loads(lines[matches[0]].split("=", 1)[1].strip().strip("'\"")) == registry
if enable_vision:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("vision_prepare", RELEASE / "scripts/ops/prepare-deepseek-vision.py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    proposed_env, changed_registry = helper.prepare_env(env_bytes)
    # A later code release may keep the already-enabled route unchanged.
    assert (BACKUP / "vision-candidate.env").read_bytes() == proposed_env, "Preflight candidate is stale or differs from deployment"
    proposed_registry = json.loads(next(line.split("=", 1)[1] for line in proposed_env.decode().splitlines()
                                        if line.startswith(MODEL_ENV + "=")))
else:
    new_model = json.loads((RELEASE / "config/gateway.goldencode.three-provider.example.json").read_text())["goldencode-d"]
    # Historical add-model workflow is text-only. Vision requires --enable-vision
    # and the live source route, never the illustrative example's endpoint.
    new_model.pop("vision", None)
    proposed_registry = {**registry, "goldencode-d": new_model}
    lines[matches[0]] = MODEL_ENV + "=" + json.dumps(proposed_registry, separators=(",", ":")) + "\n"
    proposed_env = "".join(lines).encode()
override = override_bytes.decode()
block = re.search(r"(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)", override)
assert block
old_line = "    image: " + state["old_image"] + "\n"
assert block.group().count(old_line) == 1
proposed_override = (override[:block.start()] + block.group().replace(old_line, "    image: " + IMAGE + "\n") + override[block.end():]).encode()
(BACKUP / "deepseek-original.env").write_bytes(env_bytes)
(BACKUP / "deepseek-proposed.env").write_bytes(proposed_env)
old_previous = (ROOT / "previous").resolve()
protected = {pathlib.Path(m["Source"]).resolve() for m in meta["Mounts"] if pathlib.Path(m["Source"]).is_file()}
protected.update((RELEASE / rel).resolve() for rel in state["release_links"] if (RELEASE / rel).is_file())
protected -= {ENVFILE.resolve(), OVERRIDE.resolve()}
fingerprints = {str(p): (sha(p), p.stat().st_mode & 0o777) for p in protected}
mounts = {m["Destination"]: m["Source"] for m in meta["Mounts"]}
dbpath = pathlib.Path(mounts["/var/lib/codex-gateway"]) / "gateway.db"
# Use the same immutable control-script revision as this caller. This permits
# an ops-only update to deploy an already-built, independently verified image.
drain = ["python3", str(pathlib.Path(__file__).resolve().with_name("gateway-drain.py")), "--container", meta["Id"],
         "--timeout", "30", "--idle-stable-seconds", str(idle_seconds)]

# The shared drain helper waits for natural idle and caps closed admission.

changed = False
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
try:
    run(drain)
    changed = True
    write_atomic(ENVFILE, proposed_env, env_stat)
    write_atomic(OVERRIDE, proposed_override, override_stat)
    run(compose(RELEASE) + ["config", "--quiet"])
    up(RELEASE)
    current = inspect(CONTAINER)
    assert current["Image"] == candidate["Id"] and current["RestartCount"] == 0
    assert current["State"]["Health"]["Status"] == "healthy"
    assert current["HostConfig"]["PortBindings"] == state["port_bindings"]
    expected_env = {**old_env, MODEL_ENV: json.dumps(proposed_registry, separators=(",", ":"))}
    assert dict(v.split("=", 1) for v in current["Config"]["Env"]) == expected_env, "Unexpected runtime env change"
    for name, cid in state["others"].items():
        assert inspect(name)["Id"] == cid
    for p, fingerprint in fingerprints.items():
        assert (sha(pathlib.Path(p)), pathlib.Path(p).stat().st_mode & 0o777) == fingerprint
    public_ready("deepseek-public")
    with sqlite3.connect(dbpath.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        assert db.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == 44
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
    point("previous", state["old_current"])
    point("current", RELEASE)
except (Exception, KeyboardInterrupt):
    if changed:
        write_atomic(ENVFILE, env_bytes, env_stat)
        write_atomic(OVERRIDE, override_bytes, override_stat)
        up(pathlib.Path(state["old_current"]))
        public_ready("deepseek-rollback")
        point("current", state["old_current"])
        point("previous", old_previous)
    else:
        run(drain + ["--resume", "--timeout", "30"])
    raise

result = {"revision": REV, "previous": state["previous_revision"], "schema": 44,
          "idle_stable_seconds": idle_seconds,
          "operation": "enable-deepseek-vision" if enable_vision else "add-deepseek-model",
          "started_at": started, "completed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "changed_env": [MODEL_ENV] if proposed_env != env_bytes else [], "protected_files_preserved": len(fingerprints),
          "other_containers_preserved": len(state["others"]), "image_id": candidate["Id"]}
(BACKUP / "deepseek-deployment.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
