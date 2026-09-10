#!/usr/bin/env python3
"""R760 worker-only release. Archives must come from a tested, pushed commit.

Arguments: revision source_archive_sha256 build_archive_sha256
           [expected_current_image expected_current_override_sha256].
Does not change Gateway release symlinks. Prints metadata, never config values.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import yaml

assert len(sys.argv) in (4, 6)
revision, source_hash, build_hash = sys.argv[1:4]
assert re.fullmatch(r"[a-f0-9]{40}", revision)
assert all(re.fullmatch(r"[a-f0-9]{64}", h) for h in (source_hash, build_hash))
base = Path('/opt/codex-gateway-r760')
worker = 'codex_gateway_r760-research-worker-1'
expected_image = 'sha256:d97bfc98b8751082f9ca1337f133c1df04e41af16c33ae2cb1216ca33b79e136'
expected_override = 'c6096af6f8cab70d87744123173de363c0d874d6a2b21a82e313e568847ed010'
if len(sys.argv) == 6:
    expected_image, expected_override = sys.argv[4:6]
assert re.fullmatch(r'sha256:[a-f0-9]{64}', expected_image)
assert re.fullmatch(r'[a-f0-9]{64}', expected_override)

def run(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode:
        # Docker/Compose diagnostics can contain environment values.
        raise RuntimeError(f'Command failed: {args[0]} {args[1]}, exit {p.returncode}')
    return p.stdout

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

old = inspect(worker)
assert old['Image'] == expected_image
labels = old['Config']['Labels']
files = labels['com.docker.compose.project.config_files'].split(',')
assert len(files) == 3 and files[-1] == str(base/'shared/config/compose.r760.override.yml')
override = Path(files[-1])
original_override = override.read_bytes()
assert sha(override) == expected_override
parsed = yaml.safe_load(original_override)
previous_worker = parsed['services'].get('research-worker')
base_override = original_override
if previous_worker is not None:
    # Only replace the exact block written by this script, preserving every
    # other service byte for byte. Unknown worker config requires review.
    assert set(previous_worker) == {'image', 'environment'}
    assert set(previous_worker['environment']) == {
        'RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN',
        'RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN', 'RESEARCH_WORKER_VERSION'}
    previous_block = ('  research-worker:\n    image: '+previous_worker['image']+'\n    environment:\n'
        '      RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN: "1000"\n'
        '      RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN: "2000000000"\n'
        '      RESEARCH_WORKER_VERSION: "'+previous_worker['environment']['RESEARCH_WORKER_VERSION']+'"\n').encode()
    assert base_override.count(previous_block) == 1
    base_override = base_override.replace(previous_block, b'', 1)
assert original_override.count(b'services:\n') == 1
envfile = Path(labels['com.docker.compose.project.environment_file'])
assert envfile.is_file() and stat.S_IMODE(envfile.stat().st_mode) & 0o007 == 0
mounts = {m['Destination']: m['Source'] for m in old['Mounts']}
for target, source in mounts.items():
    if target.startswith('/run/secrets/'):
        metadata = Path(source).stat()
        assert metadata.st_uid == 999 and stat.S_IMODE(metadata.st_mode) == 0o400
gateway = inspect('codex_gateway_r760-gateway-1')
symlinks = {name: str((base/name).resolve()) for name in ('current', 'previous')}
release = base/'releases'/revision
release.mkdir(mode=0o755, exist_ok=False)
for kind, expected in [('source', source_hash), ('build', build_hash)]:
    archive = Path('/tmp')/f'doctor-research-repair-{revision}-{kind}.tgz'
    assert sha(archive) == expected
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            assert (release/member.name).resolve().is_relative_to(release)
            assert not member.issym() and not member.islnk()
        tar.extractall(release, filter='data')
image = 'codex-gateway-research-repair:' + revision
run(['docker', 'build', '--build-arg', 'BASE_RESEARCH_IMAGE='+expected_image,
     '--build-arg', 'REPAIR_REVISION='+revision, '-f',
     str(release/'deploy/r760-research-worker-repair.Dockerfile'), '-t', image, str(release)])
image_info = json.loads(run(['docker', 'image', 'inspect', image]))[0]
assert image_info['Config']['Labels']['org.opencontainers.image.revision'] == revision
print(json.dumps({'event':'image_built','image_id':image_info['Id'],'revision':revision}), flush=True)

backup = base/'backups'/('doctor-research-repair-'+revision)
backup.mkdir(mode=0o700, exist_ok=False)
for source in [override, envfile]:
    destination = backup/source.name
    shutil.copy2(source, destination)
    os.chmod(destination, 0o600)
    assert sha(source) == sha(destination)
database = Path(mounts['/var/lib/codex-gateway-research'])/'research.db'
connection = sqlite3.connect('file:'+str(database)+'?mode=ro', uri=True)
connection.execute('PRAGMA query_only=ON')
assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
assert not connection.execute('PRAGMA foreign_key_check').fetchall()
assert connection.execute("SELECT count(*) FROM research_runs WHERE status IN ('queued','running','needs_input')").fetchone()[0] == 0
destination = backup/'research.db'
copy = sqlite3.connect(destination)
connection.backup(copy)
assert copy.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
assert not copy.execute('PRAGMA foreign_key_check').fetchall()
copy.close()
os.chmod(destination, 0o600)
metadata = {'revision':revision,'image':image,'image_id':image_info['Id'],
            'old_image':old['Image'],'old_container_id':old['Id'],
            'gateway_container_id':gateway['Id'],'symlinks':symlinks,
            'compose_files':files,'env_file':str(envfile),'backup':str(backup),
            'source_sha256':source_hash,'build_sha256':build_hash}
(backup/'release.json').write_text(json.dumps(metadata, indent=2)+'\n')
os.chmod(backup/'release.json', 0o600)
print(json.dumps({'event':'backup_verified','backup':str(backup)}), flush=True)

compose = ['docker','compose','--env-file',str(envfile),'-p','codex_gateway_r760']
for f in files: compose += ['-f',f]
compose += ['--profile','research-production']
assert sha(override) == expected_override and inspect(worker)['Id'] == old['Id']
assert inspect('codex_gateway_r760-gateway-1')['Id'] == gateway['Id']
assert connection.execute("SELECT count(*) FROM research_runs WHERE status IN ('queued','running','needs_input')").fetchone()[0] == 0
connection.close()
block = ('services:\n  research-worker:\n    image: '+image+'\n    environment:\n'
         '      RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN: "1000"\n'
         '      RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN: "2000000000"\n'
         '      RESEARCH_WORKER_VERSION: "research-repair-'+revision[:12]+'"\n').encode()
updated = base_override.replace(b'services:\n',block,1)
check = yaml.safe_load(updated)
del check['services']['research-worker']
assert check == yaml.safe_load(base_override)
temporary = override.with_suffix('.research-repair.tmp')
assert not temporary.exists()
temporary.write_bytes(updated)
os.chmod(temporary, stat.S_IMODE(override.stat().st_mode))
assert sha(override) == expected_override
os.replace(temporary,override)
try:
    run(compose+['config','--quiet'])
    run(compose+['up','-d','--no-deps','--no-build','--force-recreate','research-worker'])
except Exception:
    # Restore only our config change, never overwrite concurrent edits.
    assert override.read_bytes() == updated
    override.write_bytes(original_override)
    raise
new = inspect(worker)
assert new['Image'] == image_info['Id']
assert inspect('codex_gateway_r760-gateway-1')['Id'] == gateway['Id']
assert {name:str((base/name).resolve()) for name in symlinks} == symlinks
print(json.dumps({'event':'worker_recreated',**metadata,'new_container_id':new['Id']}),flush=True)
