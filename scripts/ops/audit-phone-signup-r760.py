import datetime, hashlib, json, pathlib, sqlite3, subprocess, urllib.request
ROOT = pathlib.Path('/opt/codex-gateway-r760')
import re, sys
REV = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}', REV)
BACKUP = ROOT / 'backups' / ('phone-signup-' + REV[:12])
state = json.loads((BACKUP / 'deployment.json').read_text())
def inspect(name): return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
meta = inspect('codex_gateway_r760-gateway-1')
assert meta['Image'] == state['candidate_image_id']
assert meta['Config']['Labels']['org.opencontainers.image.revision'] == state['revision']
assert meta['State']['Health']['Status'] == 'healthy' and meta['RestartCount'] == 0
assert str((ROOT / 'current').resolve()) == str(ROOT / 'releases' / state['revision'])
assert str((ROOT / 'previous').resolve()) == state['old_current']
assert hashlib.sha256('\n'.join(sorted(meta['Config']['Env'])).encode()).hexdigest() == state['expected_env_sha256']
for p, digest in state['expected_config_sha256'].items(): assert hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() == digest
services = {}
for name, expected in state['others'].items():
    other = inspect(name)
    assert other['Id'] == expected and other['State']['Running']
    health = other['State'].get('Health', {}).get('Status')
    assert health in [None, 'healthy']
    services[name] = {'unchanged': True, 'health': health or 'running'}
report = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'revision': state['revision'],
          'image': meta['Image'], 'health': meta['State']['Health']['Status'], 'restarts': meta['RestartCount'],
          'configuration_unchanged': True, 'services': services, 'databases': {}}
for mount in meta['Mounts']:
    names = ['gateway.db', 'client-events.db'] if mount['Destination'] == '/var/lib/codex-gateway' else ['research.db'] if mount['Destination'] == '/var/lib/codex-gateway-research' else []
    for name in names:
        path = pathlib.Path(mount['Source']) / name
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            result = {'quick_check': db.execute('PRAGMA quick_check').fetchone()[0],
                      'foreign_key_violations': len(db.execute('PRAGMA foreign_key_check').fetchall())}
            assert result == {'quick_check': 'ok', 'foreign_key_violations': 0}
            report['databases'][name] = result
            if name == 'gateway.db':
                report['schema'] = db.execute('select max(version) from schema_migrations').fetchone()[0]
                assert report['schema'] == 28
                # Compare pre-existing control rows against the verified backup;
                # never emit their names, phones, hashes or encrypted credentials.
                report['existing_control_rows'] = {}
                with sqlite3.connect((BACKUP / 'gateway.db').as_uri() + '?mode=ro', uri=True) as old:
                    old.execute('PRAGMA query_only=ON')
                    for table, key in [('subjects', 'id'), ('access_credentials', 'id'),
                                       ('unified_client_keys', 'id'), ('plans', 'id'),
                                       ('entitlements', 'id'), ('phone_auth_identities', 'subject_id')]:
                        columns = [row[1] for row in old.execute('PRAGMA table_info(' + table + ')')]
                        query = 'SELECT ' + ','.join(columns) + ' FROM ' + table
                        rows = old.execute(query).fetchall()
                        key_index = columns.index(key)
                        changed = sum(db.execute(query + ' WHERE ' + key + '=?', (row[key_index],)).fetchone() != row for row in rows)
                        report['existing_control_rows'][table] = {'checked': len(rows), 'changed': changed}
                        assert changed == 0, 'Pre-existing control rows changed: ' + table
                smoke = json.loads((BACKUP / 'public-smoke.json').read_text())
                assert smoke['assertions'] == 'passed'
                users = [item['subject_id'] for item in smoke['cleanup']]
                report['test_cleanup'] = []
                for user in users:
                    subject_state = db.execute('select state from subjects where id=?', (user,)).fetchone()[0]
                    active_credentials = db.execute('select count(*) from access_credentials where subject_id=? and revoked_at is null', (user,)).fetchone()[0]
                    unfinalized = db.execute('select count(*) from token_reservations where subject_id=? and finalized_at is null', (user,)).fetchone()[0]
                    assert subject_state == 'disabled' and active_credentials == 0 and unfinalized == 0
                    report['test_cleanup'].append({'user': user, 'disabled': True, 'active_credentials': 0, 'unfinished_reservations': 0})
        print('database_audit_passed', name, flush=True)
with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health', timeout=20) as response: health = json.load(response)
assert health['state'] == 'ready'
report['public_health'] = 'ready'
logs = subprocess.run(['docker', 'logs', '--since', state['gateway_started_at'], 'codex_gateway_r760-gateway-1'], capture_output=True, text=True)
assert logs.returncode == 0
counts = {'fatal': 0, 'error': 0, 'uncaught_exception': 0, 'unhandled_rejection': 0}
for line in (logs.stdout + '\n' + logs.stderr).splitlines():
    try: entry = json.loads(line)
    except ValueError: continue
    if not isinstance(entry, dict): continue
    if entry.get('level', 0) >= 60: counts['fatal'] += 1
    elif entry.get('level', 0) >= 50: counts['error'] += 1
    msg = str(entry.get('msg', '')).lower()
    if 'uncaught' in msg: counts['uncaught_exception'] += 1
    if 'unhandled' in msg: counts['unhandled_rejection'] += 1
assert counts['fatal'] == 0 and counts['uncaught_exception'] == 0 and counts['unhandled_rejection'] == 0
report['sanitized_log_counts'] = counts
report['assertions'] = 'passed'
(BACKUP / 'final-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
