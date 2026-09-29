"""Cut the R760 Gateway over to a prepared release (Gateway container only).

Re-checks the state recorded by release-prepare.py, swaps only the gateway image
line of the R760 override (text edit, so comments survive), closes admission and
drains actual work, recreates only the gateway with the labelled Compose files of the
new release, and verifies. Any failed post-check restores the previous override
and release and recreates the previous gateway before raising.

Originally used for 3efd505 and 3d4c10a (2026-09-23). The expected schema is now
an explicit required argument from the tested release plan. Only
CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START may change in the container environment;
review this allowlist separately for a release that changes configuration.
The image swap is scoped to the gateway service block because the research-worker
may run the same Gateway image.

    python3 - <rev> <expected-schema> < r760-gateway-release-20260923-cutover.py
    (on R760, after prepare, backup, migration rehearsal and build)
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, shutil, sqlite3, subprocess, sys, time, urllib.request

if len(sys.argv) != 3 or not sys.argv[2].isdigit():
    raise SystemExit("usage: cutover <full-revision> <tested-expected-schema>")
REV = sys.argv[1]
EXPECTED_SCHEMA = int(sys.argv[2])
assert EXPECTED_SCHEMA >= 35
assert re.fullmatch(r"[0-9a-f]{40}", REV)
ROOT = pathlib.Path("/opt/codex-gateway-r760")
RELEASE = ROOT / "releases" / REV
BACKUP = ROOT / "backups" / f"release-{REV[:12]}"
OVERRIDE = ROOT / "shared/config/compose.r760.override.yml"
CONTAINER = "codex_gateway_r760-gateway-1"
IMAGE = f"codex_gateway_r760-gateway:{REV}"
ARCHIVE_FLAG = "CODEX_GATEWAY_ROLLOUT_ARCHIVE_ON_START"
os.umask(0o077)

lock = (ROOT / ".deploy.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
state = json.loads((BACKUP / "deployment.json").read_text())
assert state["revision"] == REV

def run(args, check=True):
    result = subprocess.run(args, capture_output=True, text=True)
    if check and result.returncode:
        log = BACKUP / "cutover-failure.log"
        log.write_text(result.stdout + "\n" + result.stderr)
        os.chmod(log, 0o600)
        raise RuntimeError(f"command failed: {args[:3]}; diagnostics in {log}")
    return result

def inspect(name):
    return json.loads(run(["docker", "inspect", name]).stdout)[0]

def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

def compose(release):
    return ["docker", "compose", "--env-file", str(release / "config/research.production.compose.env"),
            "-p", "codex_gateway_r760", "-f", str(release / "compose.azure.yml"),
            "-f", str(release / "compose.research-production.yml"), "-f", str(OVERRIDE),
            "--profile", "research-production"]

def up(release):
    run(compose(release) + ["up", "-d", "--no-deps", "--no-build", "--force-recreate",
                            "--wait", "--wait-timeout", "180", "gateway"])

def point(name, target):
    tmp = ROOT / f".release-{REV[:12]}-{name}"
    if tmp.is_symlink():
        tmp.unlink()
    tmp.symlink_to(target)
    os.replace(tmp, ROOT / name)

def readonly(path):
    db = sqlite3.connect(pathlib.Path(path).as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    return db

# Preconditions recorded at prepare time.
meta = inspect(CONTAINER)
assert meta["Id"] == state["old_container_id"], "gateway container changed since prepare"
assert str((ROOT / "current").resolve()) == state["old_current"], "current symlink moved"
assert sha(OVERRIDE) == state["override_sha256"], "override changed since prepare"
candidate = inspect(IMAGE)
assert candidate["Config"]["Labels"]["org.opencontainers.image.revision"] == REV
for rel in state["release_links"]:
    assert (RELEASE / rel).exists(), f"release link {rel} does not resolve"

original = OVERRIDE.read_text()
# The research-worker may run the same image, so edit only the gateway block.
block_match = re.search(r"(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)", original)
assert block_match, "gateway service block not found"
block = block_match.group(0)
old_line = f"    image: {state['old_image']}\n"
assert block.count(old_line) == 1, "expected exactly one image line in the gateway block"
proposed = original[:block_match.start()] + block.replace(old_line, f"    image: {IMAGE}\n") + original[block_match.end():]
assert proposed.count(f"image: {IMAGE}") == 1
assert proposed.count(f"image: {state['old_image']}") == original.count(f"image: {state['old_image']}") - 1
(BACKUP / "proposed.override.yml").write_text(proposed)
os.chmod(BACKUP / "proposed.override.yml", 0o600)

mounts = {m["Destination"]: m["Source"] for m in meta["Mounts"]}
dbpath = pathlib.Path(mounts["/var/lib/codex-gateway"]) / "gateway.db"
with readonly(dbpath) as db:
    assert db.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] <= EXPECTED_SCHEMA, "refusing schema regression"
# Old runtimes without drain support fail closed here. The first upgrade needs
# an explicit maintenance ingress gate; reservation counts are never a fallback.
drain_command = ["python3", str(RELEASE / "scripts/ops/gateway-drain.py"), "--container", meta["Id"]]

cutover_at = datetime.datetime.now(datetime.timezone.utc)
changed = False
try:
    run(drain_command)
    changed = True
    OVERRIDE.write_text(proposed)
    os.chmod(OVERRIDE, 0o644)
    run(compose(RELEASE) + ["config", "--quiet"])
    up(RELEASE)
    current = inspect(CONTAINER)
    assert current["Image"] == candidate["Id"], "gateway is not running the candidate image"
    assert current["RestartCount"] == 0, "gateway restarted"
    assert current["State"]["Health"]["Status"] == "healthy", "gateway is not healthy"
    assert current["HostConfig"]["PortBindings"] == state["port_bindings"], "port bindings changed"
    # Only the startup-archive flag may change (0 in the override since 2026-09-22).
    old_env, new_env = set(state["env"]), set(current["Config"]["Env"])
    removed = {e.split("=", 1)[0] for e in old_env - new_env}
    added = {e.split("=", 1)[0] for e in new_env - old_env}
    assert removed <= {ARCHIVE_FLAG} and added <= {ARCHIVE_FLAG}, f"unexpected env change: {sorted(removed | added)}"
    assert f"{ARCHIVE_FLAG}=0" in new_env, "startup archive flag is not 0"
    for name, cid in state["others"].items():
        assert inspect(name)["Id"] == cid, f"{name} was recreated"
    with urllib.request.urlopen("https://goldencode.instmarket.com.au:1443/gateway/health", timeout=25) as response:
        assert json.load(response)["state"] == "ready", "public health is not ready"
    with readonly(dbpath) as db:
        schema = db.execute("SELECT max(version) FROM schema_migrations").fetchone()[0]
        quick = db.execute("PRAGMA quick_check").fetchone()[0]
        violations = len(db.execute("PRAGMA foreign_key_check").fetchall())
    assert schema == EXPECTED_SCHEMA, f"unexpected schema {schema}; expected {EXPECTED_SCHEMA}"
    assert quick == "ok" and violations == 0, "live database failed integrity"
    logs = run(["docker", "logs", "--since", cutover_at.strftime("%Y-%m-%dT%H:%M:%SZ"), CONTAINER]).stdout \
        + run(["docker", "logs", "--since", cutover_at.strftime("%Y-%m-%dT%H:%M:%SZ"), CONTAINER]).stderr
    archive_warning = "Codex rollout startup archive failed" in logs
    point("previous", state["old_current"])
    point("current", str(RELEASE))
except (Exception, KeyboardInterrupt):
    if changed:
        (BACKUP / "cutover-rolled-back").write_text(datetime.datetime.now(datetime.timezone.utc).isoformat())
        OVERRIDE.write_text(original)
        os.chmod(OVERRIDE, 0o644)
        subprocess.run(compose(pathlib.Path(state["old_current"])) + ["up", "-d", "--no-deps", "--no-build",
                       "--force-recreate", "--wait", "--wait-timeout", "180", "gateway"], capture_output=True, text=True)
    else:
        # Drain can fail after closing admission. Resume only the original instance;
        # --resume checks protocol support and verifies that admission is open.
        try:
            run(drain_command + ["--resume", "--timeout", "30"])
        except Exception as recovery_error:
            raise RuntimeError("Cutover aborted; could not verify recovery of the old Gateway admission") from recovery_error
    raise

state.update(candidate_image_id=candidate["Id"], cutover_at=cutover_at.isoformat(),
             deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
             gateway_container_id=inspect(CONTAINER)["Id"], schema_version=schema,
             active_override_sha256=sha(OVERRIDE), startup_archive_warning=archive_warning)
(BACKUP / "deployment.json").write_text(json.dumps(state, indent=2))
os.chmod(BACKUP / "deployment.json", 0o600)
print(json.dumps({"deployed": REV, "previous": state["previous_revision"], "schema_version": schema,
                  "quick_check": quick, "foreign_key_violations": violations,
                  "startup_archive_warning": archive_warning,
                  "current": str((ROOT / "current").resolve()),
                  "previous_link": str((ROOT / "previous").resolve())}, indent=2))
