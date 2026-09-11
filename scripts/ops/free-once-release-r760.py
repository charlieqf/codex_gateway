#!/usr/bin/env python3
"""R760 Gateway release for the one-off Free allowance (schema 30).

Runs on the R760 host as root. Subcommands (REV = 40-hex commit):

  prepare        REV OLD_GATEWAY_REVISION
  migration-smoke REV
  cutover        REV
  audit          REV

The candidate image is codex_gateway_r760-gateway:<REV>, built separately from
deploy/r760-phone-signup.Dockerfile on top of the base tag that `prepare`
records. Cutover is forward-only: after schema 30 the old image would read the
migrated Free snapshots as unlimited, so no automatic image rollback exists.
No credentials, env values or rendered Compose configuration are printed.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, shutil, sqlite3, stat, subprocess, sys, time, urllib.request

ROOT = pathlib.Path('/opt/codex-gateway-r760')
CONTAINER = 'codex_gateway_r760-gateway-1'
OTHERS = ['codex_gateway_r760-research-worker-1', 'codex_gateway_r760-research-llm-gateway-1',
          'codex_gateway_r760-research-maintenance-1', 'codex_gateway_r760-mihomo-1', 'qwen38-fp8-local']
LEGACY_FREE = ('plan_free_daily_100k_v1', 'plan_free_daily_10k_v1', 'plan_free_daily_1m_v1')
ONCE_PLAN = 'plan_free_once_1m_v1'
EXPECTED_SCHEMA = 30

mode, rev = sys.argv[1], sys.argv[2]
assert mode in ('prepare', 'migration-smoke', 'cutover', 'audit') and re.fullmatch(r'[0-9a-f]{40}', rev)
RELEASE = ROOT / 'releases' / rev
BACKUP = ROOT / 'backups' / ('free-once-' + rev[:12])
IMAGE = 'codex_gateway_r760-gateway:' + rev
OVERRIDE = ROOT / 'shared/config/compose.r760.override.yml'
os.umask(0o077)
lock = (ROOT / '.deploy.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def now_iso(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def output(args, **kw): return subprocess.check_output(args, text=True, **kw)
def inspect(name): return json.loads(output(['docker', 'inspect', name]))[0]
def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()
def env_sha(meta): return hashlib.sha256('\n'.join(sorted(meta['Config']['Env'])).encode()).hexdigest()
def read_db(path):
    db = sqlite3.connect(pathlib.Path(path).as_uri() + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    return db
def integrity(path):
    with read_db(path) as db:
        result = {'quick_check': db.execute('PRAGMA quick_check').fetchone()[0],
                  'foreign_key_violations': len(db.execute('PRAGMA foreign_key_check').fetchall())}
    assert result == {'quick_check': 'ok', 'foreign_key_violations': 0}, result
    return result
def write_json(name, value):
    path = BACKUP / name
    path.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(path, 0o600)
def state_load(): return json.loads((BACKUP / 'deployment.json').read_text())
def compose(env_file, release, override):
    return ['docker', 'compose', '--env-file', env_file, '-p', 'codex_gateway_r760',
            '-f', str(release / 'compose.azure.yml'), '-f', str(release / 'compose.research-production.yml'),
            '-f', str(override), '--profile', 'research-production']
def gateway_db_path(meta):
    mount = next(m for m in meta['Mounts'] if m['Destination'] == '/var/lib/codex-gateway')
    return pathlib.Path(mount['Source']) / 'gateway.db'
def point(name, target):
    temporary = ROOT / ('.free-once-' + name)
    assert not temporary.exists() and not temporary.is_symlink()
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / name)
def emit(**value): print(json.dumps(value), flush=True)


if mode == 'prepare':
    old_rev = sys.argv[3]
    assert re.fullmatch(r'[0-9a-f]{40}', old_rev) and old_rev != rev
    meta = inspect(CONTAINER)
    assert meta['Config']['Labels']['org.opencontainers.image.revision'] == old_rev, 'Running Gateway revision differs'
    assert meta['State'].get('Health', {}).get('Status') == 'healthy' and meta['RestartCount'] == 0
    assert RELEASE.is_dir() and (RELEASE / 'compose.azure.yml').is_file() and (RELEASE / 'compose.research-production.yml').is_file()
    assert (RELEASE / 'scripts/ops/free-once-migration-smoke.mjs').is_file()
    BACKUP.mkdir(mode=0o700, exist_ok=False)
    state = {'revision': rev, 'old_gateway_revision': old_rev,
             'old_current': str((ROOT / 'current').resolve()), 'old_previous': str((ROOT / 'previous').resolve()),
             'old_image_id': meta['Image'], 'old_image_tag': meta['Config']['Image'], 'old_container_id': meta['Id'],
             'config_files': meta['Config']['Labels']['com.docker.compose.project.config_files'],
             'compose_env_file': meta['Config']['Labels']['com.docker.compose.project.environment_file'],
             'env_sha256': env_sha(meta), 'port_bindings': meta['HostConfig']['PortBindings'],
             'others': {name: inspect(name)['Id'] for name in OTHERS},
             'config_sha256': {}, 'backup_databases': {}, 'prepared_at': now_iso()}
    for p in sorted((ROOT / 'shared/config').iterdir()):
        if '.bak-' in p.name or not p.is_file(): continue
        st = p.stat()
        assert st.st_uid == 0
        if p.suffix == '.env': assert stat.S_IMODE(st.st_mode) == 0o600
        shutil.copy2(p, BACKUP / p.name)
        os.chmod(BACKUP / p.name, 0o600)
        state['config_sha256'][str(p)] = sha(p)
        assert sha(BACKUP / p.name) == state['config_sha256'][str(p)]
    state['override_sha256'] = state['config_sha256'][str(OVERRIDE)]
    for mount in meta['Mounts']:
        if mount['Destination'].startswith('/run/secrets/'):
            assert stat.S_IMODE(pathlib.Path(mount['Source']).stat().st_mode) & 0o007 == 0, 'Secret mount is world readable'
        names = {'/var/lib/codex-gateway': ['gateway.db', 'client-events.db'],
                 '/var/lib/codex-gateway-research': ['research.db']}.get(mount['Destination'], [])
        for name in names:
            src = pathlib.Path(mount['Source']) / name
            dest = BACKUP / name
            with read_db(src) as db, sqlite3.connect(dest) as copy:
                db.backup(copy, pages=1024, sleep=0.05)
            os.chmod(dest, 0o600)
            state['backup_databases'][name] = {**integrity(dest), 'bytes': dest.stat().st_size, 'sha256': sha(dest)}
            emit(event='backup_verified', database=name, bytes=state['backup_databases'][name]['bytes'])
    with read_db(BACKUP / 'gateway.db') as db:
        state['pre_schema'] = db.execute('select max(version) from schema_migrations').fetchone()[0]
        state['pre_active_legacy_free'] = db.execute(
            f"select count(*) from entitlements where plan_id in {LEGACY_FREE} and state='active' "
            "and period_kind='unlimited' and period_end is null").fetchone()[0]
        assert state['pre_schema'] == EXPECTED_SCHEMA - 1
    for p in (pathlib.Path(state['old_current']) / 'config').iterdir():
        if p.is_symlink():
            target = p.resolve()
            if target.is_relative_to(ROOT / 'shared'):
                dest = RELEASE / 'config' / p.name
                if dest.is_symlink():
                    assert dest.resolve() == target
                else:
                    assert not dest.exists(), p.name
                    dest.symlink_to(target)
    with (BACKUP / 'compose-validation.log').open('w') as log:
        subprocess.run(compose(state['compose_env_file'], RELEASE, OVERRIDE) + ['config', '--quiet'],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    base_tag = 'codex_gateway_r760-gateway:free-once-base-' + rev[:12]
    subprocess.run(['docker', 'tag', meta['Image'], base_tag], check=True)
    state['base_image_tag'] = base_tag
    write_json('deployment.json', state)
    emit(event='prepared', revision=rev, backup=str(BACKUP), base_image_tag=base_tag,
         pre_schema=state['pre_schema'], pre_active_legacy_free=state['pre_active_legacy_free'])

elif mode == 'migration-smoke':
    state = state_load()
    candidate = inspect(IMAGE)
    assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == rev
    state['candidate_image_id'] = candidate['Id']
    # Isolated candidate container: no network, read-only production backup, scratch in /tmp only.
    # root inside the throwaway container only so it can read the 0600 backup; nothing is writable but /tmp.
    # The WAL-mode backup needs a writable directory for its -shm file even when
    # opened read-only, so the container copies it from the read-only host mount
    # into a private tmpfs before the smoke opens it.
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=2g',
            '--tmpfs', '/input:size=1g', '--user', '0:0',
            '-v', f'{BACKUP / "gateway.db"}:/host-backup/gateway.db:ro',
            '-v', f'{RELEASE / "scripts"}:/app/scripts:ro',
            '-w', '/app', '--entrypoint']
    migration = json.loads(output(args + ['sh', IMAGE, '-c',
        'cp /host-backup/gateway.db /input/gateway.db && exec node scripts/ops/free-once-migration-smoke.mjs']
    ).strip().splitlines()[-1])
    args = args + ['node', IMAGE]
    assert migration['assertions'] == 'passed' and migration['schema'] == EXPECTED_SCHEMA
    assert migration['migrated_free']['active_daily_before'] == state['pre_active_legacy_free']
    assert migration['migrated_free']['once_after'] == state['pre_active_legacy_free']
    write_json('migration-smoke.json', migration)
    compiled = subprocess.run(args + ['scripts/ops/free-paid-quota-smoke.mjs'], capture_output=True, text=True)
    (BACKUP / 'compiled-smoke.log').write_text(compiled.stdout + '\n' + compiled.stderr)
    os.chmod(BACKUP / 'compiled-smoke.log', 0o600)
    assert compiled.returncode == 0, 'compiled-route smoke failed'
    state['migration_smoke_at'] = now_iso()
    write_json('deployment.json', state)
    emit(event='migration_smoke_passed', **migration['migrated_free'], preserved=migration['preserved'])

elif mode == 'cutover':
    state = state_load()
    meta = inspect(CONTAINER)
    assert meta['Id'] == state['old_container_id'] and str((ROOT / 'current').resolve()) == state['old_current']
    for path, expected in state['config_sha256'].items():
        assert sha(path) == expected, 'Configuration changed since prepare'
    for name, expected in state['others'].items(): assert inspect(name)['Id'] == expected, name
    candidate = inspect(IMAGE)
    assert candidate['Id'] == state['candidate_image_id'], 'Run migration-smoke on this candidate first'
    buildlog = ROOT / 'staging' / rev / 'build.log'
    shutil.copy2(buildlog, BACKUP / 'build.log'); os.chmod(BACKUP / 'build.log', 0o600)
    # Only the gateway service image line changes; every other byte of the override is preserved.
    original = OVERRIDE.read_text()
    old_line = f"    image: {state['old_image_tag']}\n"
    assert original.count(old_line) == 1, 'Expected exactly one gateway image line'
    proposed = original.replace(old_line, f"    image: {IMAGE}\n")
    proposed_path = BACKUP / 'proposed.override.yml'
    proposed_path.write_text(proposed); os.chmod(proposed_path, 0o600)
    with (BACKUP / 'compose-configured-validation.log').open('w') as log:
        subprocess.run(compose(state['compose_env_file'], RELEASE, proposed_path) + ['config', '--quiet'],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    rendered = json.loads(output(compose(state['compose_env_file'], RELEASE, proposed_path) + ['config', '--format', 'json']))
    assert rendered['services']['gateway']['image'] == IMAGE
    dbpath = gateway_db_path(meta)
    with read_db(dbpath) as db:
        for attempt in range(31):
            pending = db.execute('select count(*) from token_reservations where finalized_at is null').fetchone()[0]
            if pending == 0: break
            emit(event='waiting_for_requests', pending=pending)
            if attempt == 30: raise RuntimeError('Requests still active; cutover deferred')
            time.sleep(2)
    state['cutover_started_at'] = now_iso()
    state['recovery_mode'] = 'forward-only-preserve-once-free-ledger'
    write_json('deployment.json', state)
    subprocess.run(['docker', 'stop', '-t', '30', CONTAINER], check=True, stdout=subprocess.DEVNULL)
    temp = OVERRIDE.with_suffix('.free-once.tmp'); assert not temp.exists()
    shutil.copyfile(proposed_path, temp); os.chmod(temp, stat.S_IMODE(OVERRIDE.stat().st_mode)); os.replace(temp, OVERRIDE)
    point('previous', state['old_current'])
    point('current', str(RELEASE))
    with (BACKUP / 'recreate.log').open('w') as log:
        subprocess.run(compose(state['compose_env_file'], RELEASE, OVERRIDE) +
                       ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'gateway'],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    emit(event='gateway_recreated')
    for attempt in range(48):
        current = inspect(CONTAINER)
        if current['State'].get('Health', {}).get('Status') == 'healthy': break
        assert current['State']['Running'], 'Gateway exited; forward repair required'
        if attempt == 47: raise RuntimeError('Gateway health deadline exceeded; forward repair required')
        time.sleep(5)
    assert current['Image'] == candidate['Id'] and current['RestartCount'] == 0
    assert current['HostConfig']['PortBindings'] == state['port_bindings']
    assert env_sha(current) == state['env_sha256'], 'Gateway environment changed'
    for name, expected in state['others'].items(): assert inspect(name)['Id'] == expected, name
    with urllib.request.urlopen('http://127.0.0.1:18787/gateway/health', timeout=15) as response:
        health = json.load(response)
    assert health['state'] == 'ready'
    with read_db(dbpath) as db:
        schema = db.execute('select max(version) from schema_migrations').fetchone()[0]
        once = db.execute(f"select count(*) from entitlements where plan_id='{ONCE_PLAN}' and state='active'").fetchone()[0]
    assert schema == EXPECTED_SCHEMA and once == state['pre_active_legacy_free']
    state.update(deployed_at=now_iso(), gateway_started_at=current['State']['StartedAt'],
                 gateway_container_id=current['Id'], override_sha256_after=sha(OVERRIDE))
    write_json('deployment.json', state)
    emit(event='deployed', revision=rev, image=current['Image'], health=health['state'], schema=schema,
         migrated_free=once, restart_count=current['RestartCount'])

else:
    state = state_load()
    assert 'deployed_at' in state
    meta = inspect(CONTAINER)
    assert meta['Image'] == state['candidate_image_id'] and meta['Id'] == state['gateway_container_id']
    assert meta['Config']['Labels']['org.opencontainers.image.revision'] == rev
    assert meta['State']['Health']['Status'] == 'healthy' and meta['RestartCount'] == 0
    assert str((ROOT / 'current').resolve()) == str(RELEASE) and str((ROOT / 'previous').resolve()) == state['old_current']
    assert env_sha(meta) == state['env_sha256'] and sha(OVERRIDE) == state['override_sha256_after']
    for path, expected in state['config_sha256'].items():
        if path != str(OVERRIDE): assert sha(path) == expected
    services = {}
    for name, expected in state['others'].items():
        other = inspect(name)
        assert other['Id'] == expected and other['State']['Running']
        health = other['State'].get('Health', {}).get('Status')
        assert health in [None, 'healthy']
        services[name] = {'unchanged': True, 'health': health or 'running'}
    report = {'checked_at': now_iso(), 'revision': rev, 'image': meta['Image'], 'health': 'healthy', 'restarts': 0,
              'configuration_unchanged_except_gateway_image': True, 'services': services, 'databases': {}}
    for mount in meta['Mounts']:
        names = {'/var/lib/codex-gateway': ['gateway.db', 'client-events.db'],
                 '/var/lib/codex-gateway-research': ['research.db']}.get(mount['Destination'], [])
        for name in names:
            path = pathlib.Path(mount['Source']) / name
            report['databases'][name] = integrity(path)
            if name != 'gateway.db': continue
            with read_db(path) as db, read_db(BACKUP / 'gateway.db') as old:
                report['schema'] = db.execute('select max(version) from schema_migrations').fetchone()[0]
                assert report['schema'] == EXPECTED_SCHEMA
                rows = {}
                for table, key in [('subjects', 'id'), ('access_credentials', 'id'), ('unified_client_keys', 'id'),
                                   ('plans', 'id'), ('phone_auth_identities', 'subject_id')]:
                    columns = [r[1] for r in old.execute(f'PRAGMA table_info({table})')]
                    query = f"SELECT {','.join(columns)} FROM {table}"
                    old_rows = old.execute(query).fetchall()
                    k = columns.index(key)
                    changed = sum(db.execute(f'{query} WHERE {key}=?', (r[k],)).fetchone() != r for r in old_rows)
                    rows[table] = {'checked': len(old_rows), 'changed': changed}
                    assert changed == 0, f'Pre-existing control rows changed: {table}'
                # Entitlements: only active legacy Free rows may differ, and only in plan_id/policy snapshot.
                columns = [r[1] for r in old.execute('PRAGMA table_info(entitlements)')]
                query = f"SELECT {','.join(columns)} FROM entitlements"
                idx = {c: i for i, c in enumerate(columns)}
                migrated, unexpected = 0, 0
                for r in old.execute(query).fetchall():
                    new = db.execute(f'{query} WHERE id=?', (r[idx['id']],)).fetchone()
                    if new == r: continue
                    legacy = (r[idx['plan_id']] in LEGACY_FREE and r[idx['state']] == 'active'
                              and r[idx['period_kind']] == 'unlimited' and r[idx['period_end']] is None)
                    same_elsewhere = all(new[i] == r[i] for c, i in idx.items() if c not in ('plan_id', 'policy_snapshot_json'))
                    old_policy = json.loads(r[idx['policy_snapshot_json']]); new_policy = json.loads(new[idx['policy_snapshot_json']])
                    expected_policy = {**old_policy, 'tokensPerDay': None, 'tokensPerMonth': None, 'tokensTotal': 1_000_000}
                    if legacy and same_elsewhere and new[idx['plan_id']] == ONCE_PLAN and new_policy == expected_policy:
                        used_old = old.execute("select coalesce(sum(total_tokens),0) from entitlement_token_windows "
                                               "where entitlement_id=? and window_kind='month'", (r[idx['id']],)).fetchone()[0]
                        period = db.execute("select total_tokens from entitlement_token_windows where entitlement_id=? "
                                            "and window_kind='period' and window_start=?", (r[idx['id']], r[idx['period_start']])).fetchone()
                        assert period is not None and period[0] == used_old, 'Lifetime window does not carry month usage'
                        migrated += 1
                    else:
                        unexpected += 1
                assert unexpected == 0 and migrated == state['pre_active_legacy_free'], (migrated, unexpected)
                rows['entitlements'] = {'checked': old.execute('select count(*) from entitlements').fetchone()[0],
                                        'migrated_legacy_free': migrated, 'unexpected_changes': unexpected}
                report['existing_control_rows'] = rows
                plan = db.execute('select state from plans where id=?', (ONCE_PLAN,)).fetchone()
                assert plan and plan[0] == 'active'
                report['once_plan'] = {'id': ONCE_PLAN, 'state': 'active'}
                smoke = json.loads((BACKUP / 'public-smoke.json').read_text())
                assert smoke['assertions'] == 'passed'
                report['test_cleanup'] = []
                for item in smoke['cleanup']:
                    user = item['subject_id']
                    subject_state = db.execute('select state from subjects where id=?', (user,)).fetchone()[0]
                    active = db.execute('select count(*) from access_credentials where subject_id=? and revoked_at is null', (user,)).fetchone()[0]
                    pending = db.execute('select count(*) from token_reservations where subject_id=? and finalized_at is null', (user,)).fetchone()[0]
                    assert subject_state == 'disabled' and active == 0 and pending == 0, user
                    report['test_cleanup'].append({'user': user, 'disabled': True, 'active_credentials': 0, 'unfinished_reservations': 0})
            emit(event='database_audit_passed', database=name)
    with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health', timeout=20) as response:
        assert json.load(response)['state'] == 'ready'
    report['public_health'] = 'ready'
    logs = subprocess.run(['docker', 'logs', '--since', state['gateway_started_at'], CONTAINER], capture_output=True, text=True)
    assert logs.returncode == 0
    counts = {'fatal': 0, 'error': 0, 'uncaught_exception': 0, 'unhandled_rejection': 0, 'migration_lines': []}
    for line in (logs.stdout + '\n' + logs.stderr).splitlines():
        try: entry = json.loads(line)
        except ValueError: continue
        if not isinstance(entry, dict): continue
        level = entry.get('level', 0)
        if level >= 60: counts['fatal'] += 1
        elif level >= 50: counts['error'] += 1
        msg = str(entry.get('msg', ''))
        if 'uncaught' in msg.lower(): counts['uncaught_exception'] += 1
        if 'unhandled' in msg.lower(): counts['unhandled_rejection'] += 1
        if 'free_allowances_migrated' in msg or 'migrated to v30' in msg: counts['migration_lines'].append(msg)
    assert counts['fatal'] == 0 and counts['uncaught_exception'] == 0 and counts['unhandled_rejection'] == 0
    report['sanitized_log_counts'] = counts
    report['assertions'] = 'passed'
    write_json('final-audit.json', report)
    emit(**report)
