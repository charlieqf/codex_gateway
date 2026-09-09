import datetime, fcntl, hashlib, json, os, pathlib, shutil, sqlite3, subprocess

import re, sys
REV = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}', REV)
ROOT = pathlib.Path('/opt/codex-gateway-r760')
RELEASE = ROOT / 'releases' / REV
BACKUP = ROOT / 'backups' / ('phone-signup-' + REV[:12])
CONTAINER = 'codex_gateway_r760-gateway-1'
os.umask(0o077)
lock = (ROOT / '.deploy.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
def output(args): return subprocess.check_output(args, text=True)
def inspect(name): return json.loads(output(['docker', 'inspect', name]))[0]
def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()
def audit(path):
    with sqlite3.connect(pathlib.Path(path).as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        result = {'quick_check': db.execute('PRAGMA quick_check').fetchone()[0],
                  'foreign_key_violations': len(db.execute('PRAGMA foreign_key_check').fetchall())}
        assert result == {'quick_check': 'ok', 'foreign_key_violations': 0}, result
        return result

meta = inspect(CONTAINER)
assert meta['Image'] == 'sha256:474c620d9604bda01644223ca101b868beb454db5922198cd1e46aff21078d70'
assert (ROOT / 'current').resolve().name == '6640d0eda4db0f90ecf6aa18adbfb95e38b8f251'
BACKUP.mkdir(mode=0o700, exist_ok=False)
state = {'revision': REV, 'old_current': str((ROOT / 'current').resolve()),
         'old_previous': str((ROOT / 'previous').resolve()), 'old_image_id': meta['Image'],
         'old_container_id': meta['Id'], 'old_image_tag': meta['Config']['Image'],
         'config_files': meta['Config']['Labels']['com.docker.compose.project.config_files'],
         'compose_env_file': meta['Config']['Labels']['com.docker.compose.project.environment_file'],
         'env_sha256': hashlib.sha256('\n'.join(sorted(meta['Config']['Env'])).encode()).hexdigest(),
         'others': {}, 'config_sha256': {}, 'backup_databases': {},
         'prepared_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
for name in ['codex_gateway_r760-research-worker-1', 'codex_gateway_r760-research-llm-gateway-1',
             'codex_gateway_r760-research-maintenance-1', 'codex_gateway_r760-mihomo-1', 'qwen38-fp8-local']:
    item = inspect(name)
    state['others'][name] = item['Id']
for p in sorted((ROOT / 'shared/config').iterdir()):
    if '.bak-' in p.name or not p.is_file(): continue
    stat = p.stat()
    assert stat.st_uid == 0
    if p.suffix == '.env': assert stat.st_mode & 0o777 == 0o600
    shutil.copy2(p, BACKUP / p.name)
    state['config_sha256'][str(p)] = sha(p)
    assert sha(BACKUP / p.name) == sha(p)
for mount in meta['Mounts']:
    if mount['Destination'].startswith('/run/secrets/'):
        p = pathlib.Path(mount['Source']); mode = p.stat().st_mode & 0o777
        assert mode & 0o007 == 0, 'Secret mount must not be world readable'
        print('protected_secret_mode', oct(mode), flush=True)
    if mount['Destination'] not in ['/var/lib/codex-gateway', '/var/lib/codex-gateway-research']: continue
    for name in (['gateway.db', 'client-events.db'] if mount['Destination'] == '/var/lib/codex-gateway' else ['research.db']):
        src = pathlib.Path(mount['Source']) / name
        dest = BACKUP / name
        with sqlite3.connect(src.as_uri() + '?mode=ro', uri=True) as db, sqlite3.connect(dest) as copy:
            db.execute('PRAGMA query_only=ON')
            db.backup(copy, pages=1024, sleep=0.05)
        os.chmod(dest, 0o600)
        state['backup_databases'][name] = {**audit(dest), 'bytes': dest.stat().st_size, 'sha256': sha(dest)}
        print('backup_verified', name, state['backup_databases'][name]['bytes'], flush=True)
for p in (pathlib.Path(state['old_current']) / 'config').iterdir():
    if p.is_symlink():
        target = p.resolve()
        if target.is_relative_to(ROOT / 'shared'):
            dest = RELEASE / 'config' / p.name
            assert not dest.exists() and not dest.is_symlink(), p.name
            dest.symlink_to(target)
(BACKUP / 'deployment.json').write_text(json.dumps(state, indent=2) + '\n')
compose = ['docker', 'compose', '--env-file', state['compose_env_file'], '-p', 'codex_gateway_r760',
           '-f', str(RELEASE / 'compose.azure.yml'), '-f', str(RELEASE / 'compose.research-production.yml'),
           '-f', str(ROOT / 'shared/config/compose.r760.override.yml'), '--profile', 'research-production']
with (BACKUP / 'compose-validation.log').open('w') as log:
    subprocess.run(compose + ['config', '--quiet'], stdout=log, stderr=subprocess.STDOUT, check=True)
print('prepared', BACKUP, flush=True)

subprocess.run(['docker', 'tag', meta['Image'], 'codex_gateway_r760-gateway:phone-signup-base-' + REV[:12]], check=True)
