import datetime, fcntl, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, time, urllib.request
import re, sys
REV = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}', REV)
ROOT = pathlib.Path('/opt/codex-gateway-r760')
RELEASE = ROOT / 'releases' / REV
BACKUP = ROOT / 'backups' / ('phone-signup-' + REV[:12])
CONTAINER = 'codex_gateway_r760-gateway-1'
IMAGE = 'codex_gateway_r760-gateway:' + REV
os.umask(0o077)
lock = (ROOT / '.deploy.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
def output(args): return subprocess.check_output(args, text=True)
def inspect(name): return json.loads(output(['docker', 'inspect', name]))[0]
def point(name, target):
    temporary = ROOT / ('.phone-signup-' + name)
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / name)
state = json.loads((BACKUP / 'deployment.json').read_text())
meta = inspect(CONTAINER)
assert meta['Id'] == state['old_container_id']
assert str((ROOT / 'current').resolve()) == state['old_current']
for path, expected in state['config_sha256'].items():
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() == expected, 'Configuration changed'
for name, expected in state['others'].items(): assert inspect(name)['Id'] == expected, name
candidate = inspect(IMAGE)
assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == REV
state['candidate_image_id'] = candidate['Id']
buildlog = ROOT / 'staging' / REV / 'build.log'
shutil.copy2(buildlog, BACKUP / 'build.log')
for line in buildlog.read_text(errors='replace').splitlines():
    if 'Tests ' in line or 'Test Files' in line: print(line, flush=True)
dbpath = next(pathlib.Path(m['Source']) / 'gateway.db' for m in meta['Mounts'] if m['Destination'] == '/var/lib/codex-gateway')
with sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True) as db:
    db.execute('PRAGMA query_only=ON')
    for attempt in range(31):
        pending = db.execute('select count(*) from token_reservations where finalized_at is null').fetchone()[0]
        if pending == 0: break
        print('waiting_for_requests', pending, flush=True)
        if attempt == 30: raise RuntimeError('Requests still active; cutover deferred')
        time.sleep(2)
compose = ['docker', 'compose', '--env-file', state['compose_env_file'], '-p', 'codex_gateway_r760',
           '-f', str(RELEASE / 'compose.azure.yml'), '-f', str(RELEASE / 'compose.research-production.yml'),
           '-f', str(ROOT / 'shared/config/compose.r760.override.yml'), '--profile', 'research-production']
state['expected_env_sha256'] = state['env_sha256']
state['expected_config_sha256'] = dict(state['config_sha256'])
changed = False
try:
    changed = True
    with (BACKUP / 'compose-configured-validation.log').open('w') as log:
        subprocess.run(compose + ['config', '--quiet'], stdout=log, stderr=subprocess.STDOUT, check=True)
    subprocess.run(['docker', 'stop', '-t', '30', CONTAINER], check=True, stdout=subprocess.DEVNULL)
    point('previous', state['old_current'])
    point('current', str(RELEASE))
    subprocess.run(['docker', 'tag', candidate['Id'], state['old_image_tag']], check=True)
    with (BACKUP / 'recreate.log').open('w') as log:
        subprocess.run(compose + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'gateway'],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    print('gateway_recreated', flush=True)
    for attempt in range(36):
        current = inspect(CONTAINER)
        if current['State'].get('Health', {}).get('Status') == 'healthy': break
        assert current['State']['Running'], 'Gateway exited'
        if attempt == 35: raise RuntimeError('Gateway health deadline exceeded')
        time.sleep(5)
    assert current['Image'] == candidate['Id']
    assert current['RestartCount'] == 0
    assert current['HostConfig']['PortBindings'] == meta['HostConfig']['PortBindings']
    assert hashlib.sha256('\n'.join(sorted(current['Config']['Env'])).encode()).hexdigest() == state['expected_env_sha256']
    for name, expected in state['others'].items(): assert inspect(name)['Id'] == expected, name
    with urllib.request.urlopen('http://127.0.0.1:18787/gateway/health', timeout=15) as response:
        health = json.load(response)
    assert health['state'] == 'ready'
    state['deployed_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    state['gateway_started_at'] = current['State']['StartedAt']
    state['gateway_container_id'] = current['Id']
    state['only_added_env'] = None
    state['other_containers_unchanged'] = True
    (BACKUP / 'deployment.json').write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps({'deployed_at': state['deployed_at'], 'revision': REV, 'image': current['Image'],
                      'health': health['state'], 'restart_count': current['RestartCount'],
                      'configuration_unchanged': True, 'other_containers_unchanged': True}), flush=True)
    changed = False
finally:
    if changed:
        print('cutover_failed_rolling_back', flush=True)
        subprocess.run(['docker', 'tag', state['old_image_id'], state['old_image_tag']], check=True)
        point('current', state['old_current'])
        point('previous', state['old_previous'])
        rollback = [arg.replace(str(RELEASE), state['old_current']) for arg in compose]
        with (BACKUP / 'rollback.log').open('w') as log:
            subprocess.run(rollback + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'gateway'],
                           stdout=log, stderr=subprocess.STDOUT, check=True)
