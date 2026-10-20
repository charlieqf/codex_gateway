"""Deploy AlphaFold integration after immutable build/backup; retain existing services.

Usage on R760: python3 alphafold-gateway-cutover.py <committed-main-revision>
The approved access policy is authenticated accounts, including future signups.
"""
import datetime
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import sys
import time
import urllib.request

spec = importlib.util.spec_from_file_location('clinical_cutover', pathlib.Path(__file__).with_name('clinical-gateway-cutover.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
SECRET = c.ROOT / 'secrets/alphafold-star-20261020'
MODES = ('alphafold',)


def proposed_override(original, old_image, revision):
    match = re.search(r'(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)', original)
    assert match, 'Gateway service missing'
    block = match.group()
    assert block.count('    image: '+old_image+'\n') == 1
    assert 'GATEWAY_ALPHAFOLD_' not in original, 'AlphaFold already configured; review before changing'
    config = {}
    mounts = []
    for mode, port in (('alphafold', 7448),):
        values = {'MODE': 'authenticated', 'SQLITE_PATH': '/var/lib/codex-gateway/clinical/'+mode+'.db',
                  'STAR_URL': 'https://192.168.77.7:'+str(port)+'/internal/'+mode+'/v1',
                  'STAR_CA_FILE': '/run/secrets/'+mode+'/star-ca.pem',
                  'STAR_TOKEN_FILE': '/run/secrets/'+mode+'/star-service.token', 'SUBJECT_IDS': '',
                  'DAILY_JOBS': '10', 'ACTIVE_JOBS': '1', 'CONTROL_TIMEOUT_MS': '15000', 'TRANSFER_TIMEOUT_MS': '300000'}
        config.update({'GATEWAY_'+mode.upper()+'_'+k: v for k, v in values.items()})
        mounts.extend(str(SECRET/name)+':/run/secrets/'+mode+'/'+name+':ro' for name in ('star-ca.pem', 'star-service.token'))
    assert block.count('    environment:\n') == 1
    block = block.replace('    environment:\n', '    environment:\n'+''.join('      '+k+': '+json.dumps(v)+'\n' for k, v in config.items()), 1)
    block = c.insert_mounts(block, mounts)
    block = block.replace('    image: '+old_image+'\n', '    image: codex_gateway_r760-gateway:'+revision+'\n')
    return original[:match.start()]+block+original[match.end():]


def proposed_vhost(original, release):
    pattern = r'(?m)^(\s*include )([^;\s]+/clinical-location\.conf)(;\s*)$'
    matches = list(re.finditer(pattern, original))
    assert len(matches) == 1, 'Expected one clinical include'
    old = pathlib.Path(matches[0].group(2))
    expected = old.read_text().replace('(aipal|panecho|echonet|echonext)', '(aipal|panecho|echonet|echonext|alphafold)')
    assert expected == (release/'config/nginx/clinical-location.conf').read_text(), 'Unexpected Nginx route change'
    return original[:matches[0].start(2)]+str(release/'config/nginx/clinical-location.conf')+original[matches[0].end(2):]


def wait_idle(meta, backup):
    mount = next(m['Source'] for m in meta['Mounts'] if m['Destination'] == '/var/lib/codex-gateway')
    db = sqlite3.connect((pathlib.Path(mount)/'gateway.db').as_uri()+'?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    start = time.monotonic(); quiet = None; last = None; samples = []
    try:
        while time.monotonic()-start < 1800:
            assert c.inspect(c.CONTAINER)['Id'] == meta['Id'], 'Container changed while awaiting idle'
            with urllib.request.urlopen('http://127.0.0.1:18787/gateway/health', timeout=5) as response:
                lifecycle = json.load(response)['lifecycle']
            assert not lifecycle['draining'], 'Another operation started draining'
            event = db.execute('SELECT max(rowid) FROM request_events WHERE public_model_id IS NOT NULL').fetchone()[0]
            idle = lifecycle['active_requests'] == lifecycle['active_work'] == 0
            now = time.monotonic()
            if not idle or event != last: quiet = now if idle else None
            elif quiet is None: quiet = now
            seconds = 0 if quiet is None else now-quiet
            sample = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **lifecycle, 'quiet_seconds': round(seconds, 2)}
            samples.append(sample); (backup/'natural-idle.json').write_text(json.dumps(samples))
            if len(samples) % 6 == 1 or seconds >= 30: print(json.dumps({'waiting_for_idle': sample}), flush=True)
            if idle and seconds >= 30: return
            last = event; time.sleep(5)
        raise RuntimeError('No natural idle window; service was not restarted')
    finally: db.close()


def main():
    revision = sys.argv[1]; assert re.fullmatch('[a-f0-9]{40}', revision)
    os.umask(0o077)
    lock = (c.ROOT/'.deploy.lock').open('a'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = c.ROOT/'releases'/revision; backup = c.ROOT/'backups'/('release-'+revision[:12]); c.BACKUP = backup
    state = json.loads((backup/'deployment.json').read_text()); old = c.inspect(c.CONTAINER); previous = (c.ROOT/'previous').resolve()
    assert old['Id'] == state['old_container_id'] and str((c.ROOT/'current').resolve()) == state['old_current'] and c.sha(c.OVERRIDE) == state['override_sha256']
    candidate = c.inspect('codex_gateway_r760-gateway:'+revision)
    assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == revision
    for mode in MODES:
        for name in ('star-ca.pem', 'star-service.token'):
            stat = (SECRET/name).stat(); assert stat.st_uid == 0 and stat.st_gid == 999 and stat.st_mode & 0o777 == 0o440
    original = c.OVERRIDE.read_text(); nginx = c.VHOST.read_text()
    proposed = proposed_override(original, state['old_image'], revision); proposed_nginx = proposed_vhost(nginx, release)
    (backup/'nginx.before.conf').write_text(nginx); (backup/'nginx.proposed.conf').write_text(proposed_nginx)
    (backup/'proposed.override.yml').write_text(proposed)
    preview = c.compose(release); preview[preview.index(str(c.OVERRIDE))] = str(backup/'proposed.override.yml')
    c.run(preview+['config', '--quiet'])
    c.integrity(old)
    wait_idle(old, backup)
    changed = False; drained = False
    try:
        drained = True; c.run(['python3', str(release/'scripts/ops/gateway-drain.py'), '--container', old['Id'], '--timeout', '180'])
        changed = True; c.OVERRIDE.write_text(proposed); c.VHOST.write_text(proposed_nginx); c.run(['nginx', '-t'])
        c.run(c.compose(release)+['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'gateway'])
        new = c.inspect(c.CONTAINER)
        assert new['Image'] == candidate['Id'] and new['RestartCount'] == 0 and new['State']['Health']['Status'] == 'healthy'
        assert new['HostConfig']['PortBindings'] == old['HostConfig']['PortBindings']
        delta = {x.split('=', 1)[0] for x in set(old['Config']['Env']) ^ set(new['Config']['Env'])}
        assert all(k.startswith('GATEWAY_ALPHAFOLD_') for k in delta)
        mounts = {m['Destination']: m for m in new['Mounts']}
        assert all(mounts[m['Destination']]['Source'] == m['Source'] and mounts[m['Destination']]['RW'] == m['RW'] for m in old['Mounts'])
        for name, cid in state['others'].items(): assert c.inspect(name)['Id'] == cid
        c.run(['systemctl', 'reload', 'nginx']); c.converge(backup/'public-convergence.json')
        checks = c.integrity(new)
        data = pathlib.Path(mounts['/var/lib/codex-gateway']['Source'])
        for mode in ('echonet', 'echonext', 'alphafold'):
            path = data/'clinical'/(mode+'.db'); assert path.exists()
            with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
                db.execute('PRAGMA query_only=ON')
                assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
            checks[mode] = {'quick_check': 'ok', 'foreign_keys': 0}
        c.point('previous', state['old_current']); c.point('current', release)
        state.update(alphafold_deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), candidate_image_id=candidate['Id'], gateway_container_id=new['Id'], alphafold_integrity=checks)
        (backup/'deployment.json').write_text(json.dumps(state, indent=2))
        print(json.dumps({'deployed': revision, 'access': 'all authenticated accounts', 'integrity': checks}), flush=True)
    except BaseException:
        c.OVERRIDE.write_text(original); c.VHOST.write_text(nginx)
        if changed:
            c.run(c.compose(pathlib.Path(state['old_current']))+['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'gateway'])
            c.run(['nginx', '-t']); c.run(['systemctl', 'reload', 'nginx']); c.converge(backup/'rollback-convergence.json')
            assert c.inspect(c.CONTAINER)['Image'] == old['Image']; c.point('current', state['old_current']); c.point('previous', previous)
        elif drained:
            c.run(['python3', str(release/'scripts/ops/gateway-drain.py'), '--container', old['Id'], '--resume', '--timeout', '30'])
            c.converge(backup/'abort-convergence.json')
        raise


if __name__ == '__main__': main()
