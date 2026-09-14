"""Guarded config-only R760 rollout. No Gateway recreate or public controller.

The helper module and acceptance evidence must be staged next to this script.
All protected configuration remains on R760. Errors never print config content.
"""
import argparse, datetime, hashlib, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request
import yaml

ROOT = pathlib.Path('/opt/codex-gateway-r760/infrastructure/mihomo')
BACKUPS = pathlib.Path('/data/codex-gateway-r760/backups')
DEPLOY = BACKUPS / 'xai-egress-20260914'
TARGET = ROOT / 'config/config.yaml'
STATIC = ROOT / 'static-manifest.sha256'
PROXY = 'codex_gateway_r760-mihomo-1'
GATEWAY = 'codex_gateway_r760-gateway-1'
EXPECTED = '59901802e7be8e502e15f0e7f6f672c352ffbf0f209cc56447612f2ddf4c451f'

def emit(x): print(json.dumps(x), flush=True)
def run(args, **kw): return subprocess.run(args, capture_output=True, text=True, check=True, **kw).stdout
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def inspect(name): return json.loads(run(['docker', 'inspect', name]))[0]

def scope():
    if DEPLOY.resolve().parent != BACKUPS.resolve() or TARGET.is_symlink() or not TARGET.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Unsafe target path')

def healthy():
    with urllib.request.urlopen('http://127.0.0.1:18787/gateway/health', timeout=10) as r:
        if r.status != 200: raise ValueError('Gateway health failed')
    for name in [PROXY, GATEWAY]:
        obj = inspect(name)
        if not obj['State']['Running'] or obj['State'].get('Health', {}).get('Status') != 'healthy':
            raise ValueError('Container not healthy')

def reservations():
    js = """import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync('/var/lib/codex-gateway/gateway.db',{readOnly:true});d.exec('PRAGMA query_only=ON');console.log(JSON.stringify(d.prepare('SELECT count(*) AS active FROM token_reservations WHERE finalized_at IS NULL').get()));d.close();"""
    return json.loads(run(['docker', 'exec', '-i', GATEWAY, 'node', '--input-type=module', '-'], input=js))['active']

def write_existing(path, contents, metadata):
    # Preserve the bind-mounted inode and original permissions; fsync before reload.
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
    with os.fdopen(fd, 'wb') as target:
        target.write(contents)
        target.flush()
        os.fsync(target.fileno())
        os.fchmod(target.fileno(), metadata['mode'])
        os.fchown(target.fileno(), metadata['uid'], metadata['gid'])

def metadata(path):
    s = path.stat()
    return {'mode': s.st_mode & 0o777, 'uid': s.st_uid, 'gid': s.st_gid, 'inode': s.st_ino}

def stage(directory, revision):
    scope()
    if DEPLOY.exists() or digest(TARGET) != EXPECTED or not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Unexpected baseline or existing rollout')
    healthy()
    run(['sha256sum', '-c', str(STATIC)], cwd=ROOT)
    evidence = json.loads((directory / 'acceptance.json').read_text())
    if not evidence.get('route_primary_passed') or not evidence.get('route_failover_passed') or not evidence.get('reload_stream_passed'):
        raise ValueError('Missing route acceptance')
    for alias in ['b', 'c']:
        record = evidence['nodes'][alias]
        if record['vision_count'] < 20 or record['vision_passed'] != record['vision_count']:
            raise ValueError('Missing node acceptance')
    if evidence['nodes']['b']['exit_ip_hash'] == evidence['nodes']['c']['exit_ip_hash']:
        raise ValueError('Primary and backup share an exit')
    module_path = directory / 'xai-egress-canary-r760.py'
    spec = importlib.util.spec_from_file_location('xai_candidate', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original = yaml.safe_load(TARGET.read_text())
    candidate = module.candidate(original)
    for key in original:
        if key not in ('proxy-groups', 'rules') and candidate[key] != original[key]:
            raise ValueError('Unrelated configuration mutation')
    if candidate['rules'][1:] != original['rules'] or candidate['proxy-groups'][:-1] != original['proxy-groups']:
        raise ValueError('Existing rules or groups changed')
    candidate_bytes = yaml.safe_dump(candidate, allow_unicode=True, sort_keys=False).encode()
    canary_path = ROOT / 'xai-canary-20260914/route/config.yaml'
    if hashlib.sha256(candidate_bytes).hexdigest() != digest(canary_path):
        raise ValueError('Candidate differs from tested normal route config')
    DEPLOY.mkdir(mode=0o700)
    for source in [TARGET, STATIC]:
        shutil.copy2(source, DEPLOY / source.name)
    (DEPLOY / 'candidate.yaml').write_bytes(candidate_bytes)
    os.chmod(DEPLOY / 'candidate.yaml', 0o400)
    copied = {}
    for name in ['xai-egress-canary-r760.py', 'xai-egress-deploy-r760.py', 'xai-egress-probe.mjs', 'acceptance.json']:
        shutil.copy2(directory / name, DEPLOY / name)
        copied[name] = digest(DEPLOY / name)
    snapshot = {obj['Name'].lstrip('/'): obj['Id'] for obj in json.loads(run(['docker', 'inspect', *run(['docker', 'ps', '-q']).split()]))}
    info = {'revision': revision, 'before_sha256': digest(TARGET), 'after_sha256': digest(DEPLOY / 'candidate.yaml'),
        'target_metadata': metadata(TARGET), 'static_metadata': metadata(STATIC), 'container_ids': snapshot, 'artifact_sha256': copied,
        'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'staged'}
    (DEPLOY / 'manifest.json').write_text(json.dumps(info, indent=2))
    if digest(DEPLOY / 'config.yaml') != info['before_sha256']:
        raise ValueError('Backup verification failed')
    emit({'action': 'staged', 'backup': str(DEPLOY), 'revision': revision, 'candidate_sha256': info['after_sha256'],
        'semantic_change': 'one xAI domain rule and one two-leaf fallback group', 'production_changed': False})

def rollback():
    scope()
    info = json.loads((DEPLOY / 'manifest.json').read_text())
    if digest(DEPLOY / 'config.yaml') != info['before_sha256']:
        raise ValueError('Backup checksum mismatch')
    if digest(TARGET) not in (info['before_sha256'], info['after_sha256']):
        raise ValueError('Refusing rollback over an unrelated config change')
    write_existing(TARGET, (DEPLOY / 'config.yaml').read_bytes(), info['target_metadata'])
    write_existing(STATIC, (DEPLOY / 'static-manifest.sha256').read_bytes(), info['static_metadata'])
    run(['docker', 'kill', '--signal=HUP', PROXY])
    time.sleep(3)
    healthy()
    run(['sha256sum', '-c', str(STATIC)], cwd=ROOT)
    emit({'action': 'rolled_back', 'config_sha256': digest(TARGET), 'healthy': True})

def apply():
    scope()
    info = json.loads((DEPLOY / 'manifest.json').read_text())
    if digest(TARGET) != info['before_sha256'] or digest(DEPLOY / 'candidate.yaml') != info['after_sha256']:
        raise ValueError('Deployment checksum mismatch')
    if inspect(PROXY)['Id'] != info['container_ids'][PROXY] or metadata(TARGET) != info['target_metadata']:
        raise ValueError('Runtime changed since staging')
    healthy()
    active = reservations()
    if active:
        emit({'action': 'deferred', 'active_reservations': active})
        return
    manifest = STATIC.read_text()
    if manifest.count(info['before_sha256']) != 1:
        raise ValueError('Unexpected static manifest')
    mutated = False
    try:
        mutated = True
        write_existing(TARGET, (DEPLOY / 'candidate.yaml').read_bytes(), info['target_metadata'])
        write_existing(STATIC, manifest.replace(info['before_sha256'], info['after_sha256']).encode(), info['static_metadata'])
        # Validate the actual bound file with the installed core before reloading.
        run(['docker', 'exec', PROXY, '/usr/local/bin/mihomo-r760', '-t', '-d', '/var/lib/mihomo', '-f', '/etc/mihomo/config.yaml'])
        run(['docker', 'kill', '--signal=HUP', PROXY])
        time.sleep(7)
        healthy()
        run(['sha256sum', '-c', str(STATIC)], cwd=ROOT)
        for name, expected in info['container_ids'].items():
            if name.startswith('xai-egress-canary-'): continue
            if inspect(name)['Id'] != expected:
                raise ValueError('Unexpected service recreation')
        info['status'] = 'applied'
        info['applied_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (DEPLOY / 'manifest.json').write_text(json.dumps(info, indent=2))
        emit({'action': 'applied', 'config_sha256': digest(TARGET), 'active_reservations_before': active,
            'container_recreated': False, 'gateway_healthy': True, 'proxy_healthy': True, 'backup': str(DEPLOY)})
    except Exception:
        if mutated:
            # A partially written candidate is our own change, restore it from the
            # verified backup before running the stricter standalone rollback.
            write_existing(TARGET, (DEPLOY / 'config.yaml').read_bytes(), info['target_metadata'])
            rollback()
        raise

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['stage', 'apply', 'rollback'])
    parser.add_argument('--directory', type=pathlib.Path)
    parser.add_argument('--revision')
    args = parser.parse_args()
    try:
        if args.action == 'stage': stage(args.directory, args.revision)
        elif args.action == 'apply': apply()
        else: rollback()
    except Exception as error:
        emit({'action': args.action, 'error_type': type(error).__name__, 'returncode': getattr(error, 'returncode', None)})
        sys.exit(1)
