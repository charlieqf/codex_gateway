"""Prepare an immutable R760 Gateway release of one origin/main revision.

Creates staging/<rev>/src and releases/<rev> from the host mirror, carries over
the non-git runtime links of the current release, records the pre-cutover state
and takes a verified database backup. Changes no running service.

Used for 3efd505 (2026-09-23). Build afterwards from staging/<rev>/src with a
packages overlay Dockerfile, then run the cutover script.

    python3 - <rev> [<verified bundle of origin/main>] < r760-gateway-release-20260923-prepare.py
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, subprocess, sys, time

REV = sys.argv[1]
assert re.fullmatch(r"[0-9a-f]{40}", REV)
ROOT = pathlib.Path("/opt/codex-gateway-r760")
MIRROR = ROOT / "staging/codex-gateway-mirror.git"
CONTAINER = "codex_gateway_r760-gateway-1"
OVERRIDE = ROOT / "shared/config/compose.r760.override.yml"
os.umask(0o022)

def run(args, **kw):
    result = subprocess.run(args, capture_output=True, **kw)
    if result.returncode:
        raise SystemExit(f"failed: {args[:4]} rc={result.returncode} {result.stderr[-400:]!r}")
    return result.stdout

def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]

def sha(data):
    return hashlib.sha256(data).hexdigest()

lock = (ROOT / ".deploy.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

# GitHub may be unreachable from R760; a verified bundle of origin/main is accepted
# instead (object hashes bind it to the same commit).
SOURCE = sys.argv[2] if len(sys.argv) > 2 else "origin"
run(["git", "-C", str(MIRROR), "fetch", "--quiet", SOURCE, "main"])
head = run(["git", "-C", str(MIRROR), "rev-parse", "FETCH_HEAD"], text=True).strip()
assert head == REV, f"{SOURCE} main is {head}, not {REV}"

meta = inspect(CONTAINER)
old_current = (ROOT / "current").resolve()
old_rev = meta["Config"]["Labels"]["org.opencontainers.image.revision"]
assert old_current.name == old_rev, "current symlink does not match the running revision"
assert meta["State"]["Health"]["Status"] == "healthy" and meta["RestartCount"] == 0

# Non-git entries of the running release must be carried over (runtime env links).
tracked = set(run(["git", "-c", "core.quotepath=off", "-C", str(MIRROR), "ls-tree", "-r", "-z",
                   "--name-only", old_rev]).decode("utf-8").split("\0"))
extras = []
for base, dirs, files in os.walk(old_current):
    for name in files + [d for d in dirs if os.path.islink(os.path.join(base, d))]:
        rel = os.path.relpath(os.path.join(base, name), old_current)
        if rel not in tracked:
            extras.append(rel)
bad = [e for e in extras if not os.path.islink(old_current / e)]
assert not bad, f"current release has untracked regular files: {bad}"

staging = ROOT / "staging" / REV
release = ROOT / "releases" / REV
assert not staging.exists() and not release.exists(), "release already prepared"
archive = run(["git", "-C", str(MIRROR), "archive", REV])
for target in (staging / "src", release):
    target.mkdir(parents=True)
    subprocess.run(["tar", "-x", "-C", str(target)], input=archive, check=True)
links = {}
for rel in sorted(extras):
    link_target = os.readlink(old_current / rel)
    dest = release / rel
    assert not os.path.lexists(dest), f"{rel} is tracked in the new revision"
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(link_target, dest)
    assert dest.exists(), f"{rel} does not resolve"
    links[rel] = link_target

backup = ROOT / "backups" / f"release-{REV[:12]}"
backup.mkdir(mode=0o700)
(backup / "previous.override.yml").write_bytes(OVERRIDE.read_bytes())
os.chmod(backup / "previous.override.yml", 0o600)

before = time.time()
run(["systemctl", "start", "codex-gateway-db-backup.service"])
status = json.loads(pathlib.Path("/data/backups/codex-gateway-daily/last-run.json").read_text())
assert status["status"] == "ok", status
assert datetime.datetime.fromisoformat(status["at"]).timestamp() >= before - 5, "backup did not run now"

project = meta["Config"]["Labels"]["com.docker.compose.project"]
others = {}
for cid in run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"], text=True).split():
    other = inspect(cid)
    name = other["Name"].lstrip("/")
    if name != CONTAINER:
        others[name] = other["Id"]

state = {
    "revision": REV, "previous_revision": old_rev,
    "old_current": str(old_current), "old_container_id": meta["Id"],
    "old_image": meta["Config"]["Image"], "old_image_id": meta["Image"],
    "env": sorted(meta["Config"]["Env"]),
    "port_bindings": meta["HostConfig"]["PortBindings"], "others": others,
    "override_sha256": sha(OVERRIDE.read_bytes()),
    "release_links": links, "db_backup": status["path"],
    "db_backup_files": status["files"],
    "prepared_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
(backup / "deployment.json").write_text(json.dumps(state, indent=2))
os.chmod(backup / "deployment.json", 0o600)
print(json.dumps({"prepared": REV, "previous": old_rev, "base_image": state["old_image"],
                  "release_links": sorted(links), "others": sorted(others),
                  "db_backup": status["path"], "db_bytes": status["total_bytes"],
                  "backup_dir": str(backup)}, indent=2))
