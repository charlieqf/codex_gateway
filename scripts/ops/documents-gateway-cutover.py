"""Approved document integration rollout after committed-main prepare/build/backup.

Usage on R760: python3 documents-gateway-cutover.py <full-main-revision>
Only Gateway image, two document settings, one secret mount and one TLS include change.
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
import urllib.request

spec = importlib.util.spec_from_file_location('idle_cutover', pathlib.Path(__file__).with_name('alphafold-gateway-cutover.py'))
idle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(idle)
c = idle.c
SETTINGS = {'CODEX_DOCUMENT_EVIDENCE_URL': 'http://172.18.0.1:8101',
            'CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE': '/run/secrets/documents/service.token'}
SECRET = c.ROOT/'secrets/documents'
DESTINATION = '/run/secrets/documents'


def proposed_override(original, old_image, revision):
    match = re.search(r'(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)', original)
    assert match, 'Gateway service missing'
    block = match.group()
    assert block.count('    image: '+old_image+'\n') == 1
    assert 'CODEX_DOCUMENT_EVIDENCE_' not in original and DESTINATION not in original, 'Documents already configured; review upgrade separately'
    assert block.count('    environment:\n') == 1
    block = block.replace('    environment:\n', '    environment:\n'+''.join('      '+k+': '+json.dumps(v)+'\n' for k, v in SETTINGS.items()), 1)
    block = c.insert_mounts(block, [str(SECRET)+':'+DESTINATION+':ro'])
    block = block.replace('    image: '+old_image+'\n', '    image: codex_gateway_r760-gateway:'+revision+'\n')
    return original[:match.start()]+block+original[match.end():]


def proposed_vhost(original, release):
    assert 'documents-location.conf' not in original and '/gateway/documents' not in original
    anchors = list(re.finditer(r'(?m)^([ \t]*)include [^;\n]+/clinical-location\.conf;[ \t]*$', original))
    assert len(anchors) == 1, 'Expected one clinical include in the existing TLS server'
    anchor = anchors[0]
    include = '\n'+anchor.group(1)+'include '+(release/'config/nginx/documents-location.conf').as_posix()+';'
    return original[:anchor.end()]+include+original[anchor.end():]


def verify_configuration(old, new):
    old_env = dict(x.split('=', 1) for x in old['Config']['Env'])
    new_env = dict(x.split('=', 1) for x in new['Config']['Env'])
    assert not set(SETTINGS) & set(old_env), 'Existing document environment was not reviewed'
    assert new_env == {**old_env, **SETTINGS}, 'Unexpected environment change'
    assert new['HostConfig']['PortBindings'] == old['HostConfig']['PortBindings'], 'Port bindings changed'
    before = {m['Destination']: m for m in old['Mounts']}
    after = {m['Destination']: m for m in new['Mounts']}
    assert set(after) == set(before) | {DESTINATION}, 'Unexpected mount change'
    for destination, mount in before.items():
        assert all(after[destination][key] == mount[key] for key in ('Source', 'RW', 'Type'))
    assert after[DESTINATION]['Source'] == str(SECRET) and after[DESTINATION]['Type'] == 'bind' and not after[DESTINATION]['RW']


def integrity(meta):
    checks = c.integrity(meta)
    root = pathlib.Path(next(m['Source'] for m in meta['Mounts'] if m['Destination'] == '/var/lib/codex-gateway'))
    for path in sorted((root/'clinical').glob('*.db')):
        with sqlite3.connect(path.as_uri()+'?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
        checks[str(path.relative_to(root))] = {'quick_check': 'ok', 'foreign_keys': 0}
    with sqlite3.connect((root/'gateway.db').as_uri()+'?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        assert db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0] == 42
    return checks


def main():
    revision = sys.argv[1]; assert re.fullmatch('[a-f0-9]{40}', revision)
    os.umask(0o077)
    lock = (c.ROOT/'.deploy.lock').open('a'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = c.ROOT/'releases'/revision; backup = c.ROOT/'backups'/('release-'+revision[:12]); c.BACKUP = backup
    state = json.loads((backup/'deployment.json').read_text()); old = c.inspect(c.CONTAINER); previous = (c.ROOT/'previous').resolve()
    assert old['Id'] == state['old_container_id'] and str((c.ROOT/'current').resolve()) == state['old_current'] and c.sha(c.OVERRIDE) == state['override_sha256']
    candidate = c.inspect('codex_gateway_r760-gateway:'+revision)
    assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == revision
    stat = (SECRET/'service.token').stat()
    assert stat.st_uid == 0 and stat.st_gid == 999 and stat.st_mode & 0o777 == 0o440
    assert (SECRET/'service.token').read_bytes() == pathlib.Path('/etc/medevidence-document-evidence/service.token').read_bytes()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(SETTINGS['CODEX_DOCUMENT_EVIDENCE_URL']+'/health', timeout=5) as response:
        worker = json.load(response); assert worker['status'] == 'ok'
    worker_revision = str(pathlib.Path('/opt/medevidence-document-evidence/current').resolve())
    original = c.OVERRIDE.read_text(); nginx = c.VHOST.read_text()
    assert (backup/'previous.override.yml').read_text() == original
    proposed = proposed_override(original, state['old_image'], revision); proposed_nginx = proposed_vhost(nginx, release)
    (backup/'nginx.before.conf').write_text(nginx); (backup/'nginx.proposed.conf').write_text(proposed_nginx)
    (backup/'proposed.override.yml').write_text(proposed)
    preview = c.compose(release); preview[preview.index(str(c.OVERRIDE))] = str(backup/'proposed.override.yml')
    c.run(preview+['config', '--quiet']); integrity(old)
    idle.wait_idle(old, backup)
    assert c.sha(c.OVERRIDE) == state['override_sha256'] and c.VHOST.read_text() == nginx, 'Configuration changed during idle wait'
    changed = False; drained = False
    try:
        drained = True; c.run(['python3', str(release/'scripts/ops/gateway-drain.py'), '--container', old['Id'], '--timeout', '180'])
        maintenance = datetime.datetime.now(datetime.timezone.utc).isoformat()
        changed = True; c.OVERRIDE.write_text(proposed); c.VHOST.write_text(proposed_nginx); c.run(['nginx', '-t'])
        c.run(c.compose(release)+['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'gateway'])
        new = c.inspect(c.CONTAINER)
        assert new['Image'] == candidate['Id'] and new['RestartCount'] == 0 and new['State']['Health']['Status'] == 'healthy'
        verify_configuration(old, new)
        c.run(['docker', 'exec', c.CONTAINER, 'test', '-r', SETTINGS['CODEX_DOCUMENT_EVIDENCE_TOKEN_FILE']])
        for name, cid in state['others'].items(): assert c.inspect(name)['Id'] == cid
        assert str(pathlib.Path('/opt/medevidence-document-evidence/current').resolve()) == worker_revision
        c.run(['systemctl', 'reload', 'nginx']); c.converge(backup/'public-convergence.json')
        checks = integrity(new)
        c.point('previous', state['old_current']); c.point('current', release)
        state.update(documents_deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), maintenance_started_at=maintenance,
                     candidate_image_id=candidate['Id'], gateway_container_id=new['Id'], schema_version=42,
                     documents_integrity=checks, worker_revision=worker_revision, worker_health=worker)
        (backup/'deployment.json').write_text(json.dumps(state, indent=2))
        print(json.dumps({'deployed': revision, 'access': 'all authenticated accounts', 'integrity': checks, 'worker': worker}), flush=True)
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
