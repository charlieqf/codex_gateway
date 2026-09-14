"""Prepare isolated leaf-node probes on R760; never changes production routing.

Run via SSH stdin: python3 - prepare|inspect|probe|cleanup [arguments].
The probe JS is supplied as a protected local file for the probe action.
"""
import argparse, copy, hashlib, json, os, pathlib, shutil, subprocess, sys, time
import yaml

ROOT = pathlib.Path('/opt/codex-gateway-r760/infrastructure/mihomo')
WORK = ROOT / 'xai-canary-20260914'
PRODUCTION = 'codex_gateway_r760-mihomo-1'
GATEWAY = 'codex_gateway_r760-gateway-1'
NODES = {'a': 'egress_1b7f0dd7373c', 'b': 'egress_2d8b4a65ca0a', 'c': 'egress_3b19a87bf0ae'}
ALIASES = [*NODES, 'route']

def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, check=True, **kwargs).stdout

def emit(value):
    print(json.dumps(value), flush=True)

def node_id(name):
    return 'egress_' + hashlib.sha256(('xai-egress-20260914:' + name).encode()).hexdigest()[:12]

def container(alias):
    if alias not in ALIASES:
        raise ValueError('Unknown node alias')
    return 'xai-egress-canary-20260914-' + alias

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def verify_scope():
    if ROOT.resolve() != pathlib.Path('/opt/codex-gateway-r760/infrastructure/mihomo') or WORK.resolve().parent != ROOT.resolve() or WORK.is_symlink():
        raise ValueError('Unsafe workspace')

def prepare():
    verify_scope()
    if WORK.exists():
        raise ValueError('Canary workspace already exists')
    production = inspect(PRODUCTION)
    baseline = {'production_id': production['Id'], 'config_sha256': hashlib.sha256((ROOT / 'config/config.yaml').read_bytes()).hexdigest()}
    config = yaml.safe_load((ROOT / 'config/config.yaml').read_text())
    WORK.mkdir(mode=0o700)
    (WORK / 'baseline.json').write_text(json.dumps(baseline))
    for alias, expected in NODES.items():
        node = next(copy.deepcopy(n) for n in config['proxies'] if node_id(n['name']) == expected)
        node['name'] = 'FIXED-' + alias.upper()
        path = WORK / alias
        path.mkdir(mode=0o700)
        os.chown(path, 999, 999)
        state = path / 'state'
        state.mkdir(mode=0o700)
        os.chown(state, 999, 999)
        minimal = {key: copy.deepcopy(config[key]) for key in ('dns', 'ipv6', 'tcp-concurrent', 'unified-delay', 'global-client-fingerprint') if key in config}
        minimal.update({'port': 7890, 'allow-lan': True, 'bind-address': '*', 'mode': 'rule', 'log-level': 'silent',
            'geo-auto-update': False, 'profile': {'store-selected': False, 'store-fake-ip': False},
            'proxies': [node], 'proxy-groups': [], 'rules': ['MATCH,' + node['name']]})
        protected = path / 'config.yaml'
        protected.write_text(yaml.safe_dump(minimal, allow_unicode=True, sort_keys=False))
        os.chown(protected, 999, 999)
        os.chmod(protected, 0o400)
        for name in ['geoip.metadb', 'GeoSite.dat', 'GeoIP.dat']:
            source = ROOT / 'state' / name
            if source.is_file():
                target = state / name
                shutil.copyfile(source, target)
                os.chown(target, 999, 999)
                os.chmod(target, 0o600)
        common = ['docker', 'run', '--rm', '--user', '999:999', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--memory', '128m', '--pids-limit', '64', '--mount', f'type=bind,src={ROOT}/bin/mihomo,dst=/mihomo,readonly',
            '--mount', f'type=bind,src={protected},dst=/config.yaml,readonly', '--mount', f'type=bind,src={state},dst=/state', '--entrypoint', '/mihomo']
        run(common + ['--network', 'none', production['Image'], '-t', '-d', '/state', '-f', '/config.yaml'])
        run(common[:2] + ['-d', '--name', container(alias), '--label', 'codex.ops=xai-egress-canary-20260914', '--log-driver', 'none'] + common[2:] + ['--network', 'codex_gateway_r760_default', production['Image'], '-d', '/state', '-f', '/config.yaml'])
        emit({'action': 'prepared', 'alias': alias, 'node_id': expected,
            'server_config_hash': hashlib.sha256(str(node.get('server')).encode()).hexdigest()[:16], 'ports_published': False})
    time.sleep(2)
    status()

def status():
    verify_scope()
    for alias in NODES:
        x = inspect(container(alias))
        emit({'action': 'status', 'alias': alias, 'running': x['State']['Running'], 'oom': x['State']['OOMKilled'],
            'published_ports': bool(x['HostConfig']['PortBindings']), 'controller_configured': False})
    baseline = json.loads((WORK / 'baseline.json').read_text())
    emit({'action': 'production_unchanged', 'container': inspect(PRODUCTION)['Id'] == baseline['production_id'],
        'config': hashlib.sha256((ROOT / 'config/config.yaml').read_bytes()).hexdigest() == baseline['config_sha256']})

def candidate(config, mode='normal'):
    if any(g['name'] == 'XAI-EGRESS' for g in config.get('proxy-groups', [])):
        raise ValueError('Dedicated group already exists')
    result = copy.deepcopy(config)
    names = {alias: next(n['name'] for n in config['proxies'] if node_id(n['name']) == NODES[alias]) for alias in ('b', 'c')}
    members = [names['b'], names['c']]
    if mode == 'failover':
        result['proxies'].append({'name': 'XAI-FAULT-TEST-ONLY', 'type': 'http', 'server': '127.0.0.1', 'port': 1})
        members[0] = 'XAI-FAULT-TEST-ONLY'
    result['proxy-groups'].append({'name': 'XAI-EGRESS', 'type': 'fallback', 'proxies': members,
        'url': 'https://api.x.ai/v1/models', 'expected-status': 401, 'interval': 60, 'timeout': 5000, 'lazy': False})
    result['rules'].insert(0, 'DOMAIN,api.x.ai,XAI-EGRESS')
    return result

def route_mode(mode):
    verify_scope()
    config = yaml.safe_load((ROOT / 'config/config.yaml').read_text())
    result = candidate(config, mode)
    path = WORK / 'route'
    if not path.exists():
        path.mkdir(mode=0o700)
        os.chown(path, 999, 999)
        (path / 'state').mkdir(mode=0o700)
        os.chown(path / 'state', 999, 999)
        for source in (ROOT / 'state').iterdir():
            if source.is_file() and source.name != 'cache.db':
                target = path / 'state' / source.name
                shutil.copyfile(source, target)
                os.chown(target, 999, 999)
                os.chmod(target, 0o600)
    protected = path / 'config.yaml'
    # Keep the inode: this file is bind-mounted by the isolated test container.
    protected.write_text(yaml.safe_dump(result, allow_unicode=True, sort_keys=False))
    os.chown(protected, 999, 999)
    os.chmod(protected, 0o400)
    production = inspect(PRODUCTION)
    common = ['docker', 'run', '--rm', '--user', '999:999', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--memory', '256m', '--pids-limit', '96', '--mount', f'type=bind,src={ROOT}/bin/mihomo,dst=/mihomo,readonly',
        '--mount', f'type=bind,src={protected},dst=/config.yaml,readonly', '--mount', f'type=bind,src={path}/state,dst=/state', '--entrypoint', '/mihomo']
    run(common + ['--network', 'none', production['Image'], '-t', '-d', '/state', '-f', '/config.yaml'])
    existing = subprocess.run(['docker', 'inspect', container('route')], capture_output=True, text=True)
    if existing.returncode == 0:
        x = json.loads(existing.stdout)[0]
        if x['Config'].get('Labels', {}).get('codex.ops') != 'xai-egress-canary-20260914':
            raise ValueError('Unexpected route container ownership')
        run(['docker', 'kill', '--signal=HUP', container('route')])
    else:
        run(common[:2] + ['-d', '--name', container('route'), '--label', 'codex.ops=xai-egress-canary-20260914', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1'] + common[2:] + ['--network', 'codex_gateway_r760_default', production['Image'], '-d', '/state', '-f', '/config.yaml'])
    time.sleep(7)
    emit({'action': 'route_mode', 'mode': mode, 'running': inspect(container('route'))['State']['Running'],
        'candidate_config_sha256': hashlib.sha256(protected.read_bytes()).hexdigest(), 'production_config_changed': False})

def route_logs():
    import re, collections
    value = subprocess.run(['docker', 'logs', '--timestamps', '--since', '10m', container('route')], capture_output=True, text=True, check=True)
    counts = collections.Counter()
    tail = []
    for line in (value.stdout + value.stderr).splitlines():
        if 'api.x.ai:443' not in line:
            continue
        match = re.search(r'using XAI-EGRESS\[(.*?)\]', line)
        if match:
            selected = node_id(match.group(1))
            counts[selected] += 1
            tail.append({'utc': line.split(' ', 1)[0], 'node_id': selected})
    emit({'action': 'route_logs', 'node_counts': dict(counts), 'last_connections': tail[-6:]})

def probe(alias, source, count, phase):
    verify_scope()
    name = container(alias)
    code = pathlib.Path(source).read_text()
    args = ['docker', 'exec', '-i', '-e', f'HTTP_PROXY=http://{name}:7890', '-e', f'HTTPS_PROXY=http://{name}:7890',
        '-e', f'http_proxy=http://{name}:7890', '-e', f'https_proxy=http://{name}:7890', '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'NO_PROXY=', '-e', 'no_proxy=',
        '-e', f'XAI_PROBE_ALIAS={alias}', '-e', f'XAI_PROBE_COUNT={count}', '-e', f'XAI_PROBE_PHASE={phase}', GATEWAY, 'node', '--input-type=module', '-']
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    process.stdin.write(code)
    process.stdin.close()
    for line in process.stdout:
        value = json.loads(line)
        emit(value)
        if phase == 'reload-inflight' and alias == 'route' and value.get('kind') == 'first_byte':
            run(['docker', 'kill', '--signal=HUP', container('route')])
            emit({'action': 'reload_during_active_stream', 'canary_only': True})
    if process.wait(timeout=20) != 0:
        raise RuntimeError('Probe process failed')

def cleanup():
    verify_scope()
    removed = 0
    for alias in ALIASES:
        name = container(alias)
        exists = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
        if exists.returncode == 0:
            x = json.loads(exists.stdout)[0]
            if x['Config'].get('Labels', {}).get('codex.ops') != 'xai-egress-canary-20260914':
                raise ValueError('Unexpected canary ownership')
            run(['docker', 'rm', '-f', name])
            removed += 1
    if WORK.exists():
        shutil.rmtree(WORK)
    emit({'action': 'cleanup', 'containers_removed': removed, 'protected_workspace_removed': not WORK.exists()})

if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'inspect', 'probe', 'cleanup', 'route-mode', 'route-logs'])
    parser.add_argument('--alias', choices=ALIASES, default='b')
    parser.add_argument('--mode', choices=['normal', 'failover'], default='normal')
    parser.add_argument('--source')
    parser.add_argument('--count', type=int, choices=range(0, 21), default=6)
    parser.add_argument('--phase', default='baseline')
    options = parser.parse_args()
    try:
        if options.action == 'prepare': prepare()
        elif options.action == 'inspect': status()
        elif options.action == 'probe': probe(options.alias, options.source, options.count, options.phase)
        elif options.action == 'route-mode': route_mode(options.mode)
        elif options.action == 'route-logs': route_logs()
        else: cleanup()
    except Exception as error:
        emit({'action': options.action, 'error_type': type(error).__name__, 'returncode': getattr(error, 'returncode', None)})
        sys.exit(1)
