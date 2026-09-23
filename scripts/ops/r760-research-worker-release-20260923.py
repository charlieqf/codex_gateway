"""Release the R760 Research Worker from a prepared Gateway release tree.

    python3 - prepare <rev>   links research secrets into releases/<rev>, records state,
                              backs up research.db, validates Compose. No service change.
    python3 - check <rev>     imports the candidate image's worker module graph offline.
    python3 - cutover <rev>   waits for no unfinished research runs, swaps only the
                              research-worker image/version lines of the override and
                              recreates only research-worker; rolls back on any failure.
Prints paths, IDs and counts only.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, sqlite3, stat, subprocess, sys, time, urllib.request

MODE, REV = sys.argv[1], sys.argv[2]
assert MODE in ("prepare", "check", "cutover") and re.fullmatch(r"[0-9a-f]{40}", REV)
ROOT = pathlib.Path("/opt/codex-gateway-r760")
RELEASE = ROOT / "releases" / REV
OVERRIDE = ROOT / "shared/config/compose.r760.override.yml"
BACKUP = ROOT / "backups" / f"research-worker-{REV[:12]}"
WORKER = "codex_gateway_r760-research-worker-1"
# The worker-only overlay mixes new packages with the base image's older
# @codex-gateway/core; the Gateway image of the same revision is consistent.
IMAGE = sys.argv[3] if len(sys.argv) > 3 else f"codex-gateway-research-worker:{REV}"
VERSION = f"research-academic-{REV[:12]}"
SECRETS = ["research-production-llm-token", "research-production-web-search-key", "research-production-tencent-key"]
os.umask(0o077)

def run(args, check=True, **kw):
    r = subprocess.run(args, capture_output=True, text=True, **kw)
    if check and r.returncode:
        BACKUP.mkdir(mode=0o700, exist_ok=True)
        log = BACKUP / f"{MODE}-failure.log"
        log.write_text(r.stdout + "\n" + r.stderr); os.chmod(log, 0o600)
        raise RuntimeError(f"command failed: {args[:3]}; diagnostics in {log}")
    return r

def inspect(name):
    return json.loads(run(["docker", "inspect", name]).stdout)[0]

def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def compose(release, override=OVERRIDE):
    return ["docker", "compose", "--env-file", str(release / "config/research.production.compose.env"),
            "-p", "codex_gateway_r760", "-f", str(release / "compose.azure.yml"),
            "-f", str(release / "compose.research-production.yml"), "-f", str(override),
            "--profile", "research-production"]

def readonly(path):
    db = sqlite3.connect(pathlib.Path(path).as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    return db

def unfinished(db_path):
    with readonly(db_path) as db:
        return db.execute("SELECT count(*) FROM research_runs WHERE status IN ('queued','running','needs_input')").fetchone()[0]

def mount_targets(meta):
    return {m["Destination"]: os.path.realpath(m["Source"]) for m in meta["Mounts"]}

lock = (ROOT / ".deploy.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
worker = inspect(WORKER)
research_db = pathlib.Path(mount_targets(worker)["/var/lib/codex-gateway-research"]) / "research.db"

if MODE == "prepare":
    assert (ROOT / "current").resolve() == RELEASE, "current is not the prepared release"
    assert worker["State"]["Health"]["Status"] == "healthy"
    BACKUP.mkdir(mode=0o700)
    secrets_dir = RELEASE / "secrets"
    secrets_dir.mkdir(mode=0o700, exist_ok=True)
    for name in SECRETS:
        target = ROOT / "shared/secrets" / name
        st = target.stat()
        assert stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) & 0o077 == 0, f"{name} unsafe"
        link = secrets_dir / name
        if not link.is_symlink():
            link.symlink_to(target)
        assert link.resolve() == target
    # Existing worker secret mounts must be the same files the new links reach.
    for dest, source in mount_targets(worker).items():
        if dest.startswith("/run/secrets/"):
            assert pathlib.Path(source).parent == ROOT / "shared/secrets", f"{dest} not from shared/secrets"
    run(compose(RELEASE) + ["config", "--quiet"])
    with readonly(research_db) as src, sqlite3.connect(BACKUP / "research.db") as dst:
        src.backup(dst)
    with readonly(BACKUP / "research.db") as db:
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
    os.chmod(BACKUP / "research.db", 0o600)
    (BACKUP / "previous.override.yml").write_bytes(OVERRIDE.read_bytes())
    os.chmod(BACKUP / "previous.override.yml", 0o600)
    project = worker["Config"]["Labels"]["com.docker.compose.project"]
    others = {}
    for cid in run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"]).stdout.split():
        m = inspect(cid)
        if m["Name"].lstrip("/") != WORKER:
            others[m["Name"].lstrip("/")] = m["Id"]
    state = {"revision": REV, "old_worker_id": worker["Id"], "old_image": worker["Config"]["Image"],
             "old_image_id": worker["Image"], "old_project_dir": worker["Config"]["Labels"]["com.docker.compose.project.working_dir"],
             "env": sorted(worker["Config"]["Env"]), "mounts": mount_targets(worker), "others": others,
             "override_sha256": sha(OVERRIDE), "research_db": str(research_db),
             "unfinished_at_prepare": unfinished(research_db),
             "prepared_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (BACKUP / "deployment.json").write_text(json.dumps(state, indent=2)); os.chmod(BACKUP / "deployment.json", 0o600)
    print(json.dumps({"prepared": REV, "base_image": state["old_image"], "secrets_linked": SECRETS,
                      "unfinished_runs": state["unfinished_at_prepare"], "backup": str(BACKUP)}, indent=2))

elif MODE == "check":
    candidate = inspect(IMAGE)
    assert candidate["Config"]["Labels"]["org.opencontainers.image.revision"] == REV
    probe = ("for (const m of ['/app/packages/store-sqlite/dist/index.js','/app/packages/research-agent/dist/index.js',"
             "'/app/apps/research-worker/dist/config.js','/app/apps/research-worker/dist/runtime.js']) "
             "{ const x = await import(m); console.log(m, Object.keys(x).length); }")
    r = run(["docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "-w", "/app",
             "--entrypoint", "node", IMAGE, "--input-type=module", "-e", probe])
    print(json.dumps({"image": candidate["Id"], "imports": r.stdout.strip().splitlines()}, indent=2))

else:
    state = json.loads((BACKUP / "deployment.json").read_text())
    assert worker["Id"] == state["old_worker_id"], "worker changed since prepare"
    assert sha(OVERRIDE) == state["override_sha256"], "override changed since prepare"
    candidate = inspect(IMAGE)
    assert candidate["Config"]["Labels"]["org.opencontainers.image.revision"] == REV
    original = OVERRIDE.read_text()
    old_image_line = f"image: {state['old_image']}"
    old_version = next(e.split("=", 1)[1] for e in state["env"] if e.startswith("RESEARCH_WORKER_VERSION="))
    assert original.count(old_image_line) == 1 and original.count(f"RESEARCH_WORKER_VERSION: {old_version}") == 1
    proposed = original.replace(old_image_line, f"image: {IMAGE}").replace(
        f"RESEARCH_WORKER_VERSION: {old_version}", f"RESEARCH_WORKER_VERSION: {VERSION}")
    (BACKUP / "proposed.override.yml").write_text(proposed); os.chmod(BACKUP / "proposed.override.yml", 0o600)
    for attempt in range(300):
        pending = unfinished(research_db)
        if pending == 0:
            break
        if attempt % 30 == 0:
            print(json.dumps({"waiting_for_research_runs": pending}), flush=True)
        if attempt == 299:
            raise RuntimeError("research runs still unfinished; cutover deferred")
        time.sleep(2)
    cutover_at = datetime.datetime.now(datetime.timezone.utc)
    changed = False
    try:
        changed = True
        OVERRIDE.write_text(proposed); os.chmod(OVERRIDE, 0o644)
        run(compose(RELEASE) + ["config", "--quiet"])
        run(compose(RELEASE) + ["up", "-d", "--no-deps", "--no-build", "--force-recreate",
                                "--wait", "--wait-timeout", "180", "research-worker"])
        new = inspect(WORKER)
        assert new["Image"] == candidate["Id"], "worker is not running the candidate"
        assert new["RestartCount"] == 0 and new["State"]["Health"]["Status"] == "healthy"
        old_env, new_env = set(state["env"]), set(new["Config"]["Env"])
        changed_keys = {e.split("=", 1)[0] for e in old_env ^ new_env}
        assert changed_keys <= {"RESEARCH_WORKER_VERSION"}, f"unexpected env change: {sorted(changed_keys)}"
        assert f"RESEARCH_WORKER_VERSION={VERSION}" in new_env
        assert mount_targets(new) == state["mounts"], "worker mounts resolve to different files"
        for name, cid in state["others"].items():
            assert inspect(name)["Id"] == cid, f"{name} was recreated"
        with urllib.request.urlopen("https://goldencode.instmarket.com.au:1443/gateway/health", timeout=25) as r:
            assert json.load(r)["state"] == "ready"
        with readonly(research_db) as db:
            quick = db.execute("PRAGMA quick_check").fetchone()[0]
            fk = len(db.execute("PRAGMA foreign_key_check").fetchall())
        assert quick == "ok" and fk == 0
    except Exception:
        if changed:
            OVERRIDE.write_text(original); os.chmod(OVERRIDE, 0o644)
            subprocess.run(compose(pathlib.Path(state["old_project_dir"])) + ["up", "-d", "--no-deps", "--no-build",
                           "--force-recreate", "--wait", "--wait-timeout", "180", "research-worker"],
                           capture_output=True, text=True)
            (BACKUP / "cutover-rolled-back").write_text(datetime.datetime.now(datetime.timezone.utc).isoformat())
        raise
    state.update(cutover_at=cutover_at.isoformat(), candidate_image_id=candidate["Id"],
                 worker_container_id=new["Id"], version=VERSION, active_override_sha256=sha(OVERRIDE),
                 deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    (BACKUP / "deployment.json").write_text(json.dumps(state, indent=2)); os.chmod(BACKUP / "deployment.json", 0o600)
    print(json.dumps({"deployed": REV, "image": IMAGE, "version": VERSION, "quick_check": quick,
                      "foreign_key_violations": fk, "cutover_at": cutover_at.isoformat()}, indent=2))
