"""Retire AF2 only after AF3 public acceptance; never restore an AF2 runtime.

Usage: python3 retire-alphafold-r760.py <committed-main-revision> <AF3-receipt>
Only Gateway is recreated. AF3 and all other active services keep their configuration.
A failure after cutover is repaired forward; the explicit AF2 retirement policy
forbids automatically restoring the old AF2-enabled image/configuration.
"""
import datetime, fcntl, importlib.util, json, os, pathlib, re, sqlite3, sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('af3_cutover', pathlib.Path(__file__).with_name('alphafold3-gateway-cutover.py'))
af3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(af3)
c = af3.c
AF2_MOUNTS = {'/run/secrets/alphafold/star-ca.pem', '/run/secrets/alphafold/star-service.token'}

def proposed_override(original, old_image, revision):
    match = re.search(r'(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)', original)
    assert match
    block = match.group()
    assert block.count('    image: '+old_image+'\n') == 1
    assert 'GATEWAY_ALPHAFOLD3_MODE:' in block
    keys = re.findall(r'^      (GATEWAY_ALPHAFOLD_[A-Z_]+):.*$', block, re.M)
    assert set(keys) == {'GATEWAY_ALPHAFOLD_'+name for name in ('MODE','SQLITE_PATH','STAR_URL','STAR_CA_FILE','STAR_TOKEN_FILE','SUBJECT_IDS','DAILY_JOBS','ACTIVE_JOBS','CONTROL_TIMEOUT_MS','TRANSFER_TIMEOUT_MS')}
    block = re.sub(r'^      GATEWAY_ALPHAFOLD_[A-Z_]+:.*\n', '', block, flags=re.M)
    for destination in AF2_MOUNTS:
        pattern = r'^ +- /opt/codex-gateway-r760/secrets/alphafold-star-20261020/[^:\n]+:'+re.escape(destination)+r':ro\n'
        block, count = re.subn(pattern, '', block, flags=re.M)
        assert count == 1, 'Expected exactly one AF2 credential mount'
    block = block.replace('    image: '+old_image+'\n', '    image: codex_gateway_r760-gateway:'+revision+'\n')
    proposed = original[:match.start()]+block+original[match.end():]
    assert 'GATEWAY_ALPHAFOLD_' not in proposed and '/run/secrets/alphafold/' not in proposed
    return proposed

def proposed_vhost(original, release):
    pattern = r'(?m)^(\s*include )([^;\s]+/clinical-location\.conf)(;\s*)$'
    matches = list(re.finditer(pattern, original)); assert len(matches) == 1
    expected = pathlib.Path(matches[0].group(2)).read_text().replace('(aipal|panecho|echonet|echonext|alphafold|alphafold3)', '(aipal|panecho|echonet|echonext|alphafold3)')
    assert expected == (release/'config/nginx/clinical-location.conf').read_text()
    return original[:matches[0].start(2)]+str(release/'config/nginx/clinical-location.conf')+original[matches[0].end(2):]

def accepted(path):
    receipt = json.loads(pathlib.Path(path).read_text())
    assert receipt['status'] == 'passed'
    assert receipt['capabilities']['available'] and receipt['capabilities']['analysis_profile'] == 'alphafold3-monomer-public-msa-v1'
    assert len(receipt['artifacts']) == 7 and all(a['verified'] for a in receipt['artifacts'])
    assert any(j['state'] == 'completed' and j['deleted'] for j in receipt['jobs'])
    assert any(j['state'] == 'cancelled' and j['phase_at_cancel'] == 'predicting' and j['deleted'] for j in receipt['jobs'])
    return receipt

def main():
    revision = sys.argv[1]; assert re.fullmatch('[a-f0-9]{40}', revision)
    accepted(sys.argv[2])
    os.umask(0o077)
    lock = (c.ROOT/'.deploy.lock').open('a'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = c.ROOT/'releases'/revision; backup = c.ROOT/'backups'/('release-'+revision[:12]); c.BACKUP = backup
    state = json.loads((backup/'deployment.json').read_text()); old = c.inspect(c.CONTAINER)
    assert old['Id'] == state['old_container_id'] and str((c.ROOT/'current').resolve()) == state['old_current'] and c.sha(c.OVERRIDE) == state['override_sha256']
    candidate = c.inspect('codex_gateway_r760-gateway:'+revision)
    assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == revision
    data = pathlib.Path(next(m['Source'] for m in old['Mounts'] if m['Destination'] == '/var/lib/codex-gateway'))
    with sqlite3.connect((data/'clinical/alphafold.db').as_uri()+'?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        assert db.execute("SELECT count(*) FROM clinical_intents WHERE revoked=0 AND state IN ('pending','uploading','queued','running','cancel_requested','deleting') AND expires>?", (datetime.datetime.now().timestamp(),)).fetchone()[0] == 0
    original = c.OVERRIDE.read_text(); nginx = c.VHOST.read_text()
    proposed = proposed_override(original, state['old_image'], revision)
    proposed_nginx = proposed_vhost(nginx, release)
    (backup/'nginx.before.conf').write_text(nginx); (backup/'nginx.proposed.conf').write_text(proposed_nginx)
    (backup/'proposed.override.yml').write_text(proposed)
    preview = c.compose(release); preview[preview.index(str(c.OVERRIDE))] = str(backup/'proposed.override.yml')
    c.run(preview+['config','--quiet']); c.integrity(old); af3.wait_idle(old, backup)
    c.run(['python3', str(release/'scripts/ops/gateway-drain.py'), '--container', old['Id'], '--timeout','180'])
    c.OVERRIDE.write_text(proposed); c.VHOST.write_text(proposed_nginx); c.run(['nginx','-t'])
    c.run(c.compose(release)+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','180','gateway'])
    new = c.inspect(c.CONTAINER)
    assert new['Image'] == candidate['Id'] and new['RestartCount'] == 0 and new['State']['Health']['Status'] == 'healthy'
    assert new['HostConfig']['PortBindings'] == old['HostConfig']['PortBindings']
    delta = {x.split('=',1)[0] for x in set(old['Config']['Env']) ^ set(new['Config']['Env'])}
    assert all(k.startswith('GATEWAY_ALPHAFOLD_') for k in delta)
    assert not any(x.startswith('GATEWAY_ALPHAFOLD_') for x in new['Config']['Env'])
    mounts = {m['Destination']:m for m in new['Mounts']}
    assert not AF2_MOUNTS.intersection(mounts)
    assert all(mounts[m['Destination']]['Source'] == m['Source'] and mounts[m['Destination']]['RW'] == m['RW'] for m in old['Mounts'] if m['Destination'] not in AF2_MOUNTS)
    for name, cid in state['others'].items(): assert c.inspect(name)['Id'] == cid
    c.run(['systemctl','reload','nginx']); c.converge(backup/'public-convergence.json')
    checks = c.integrity(new)
    for mode in ('echonet','echonext','alphafold3'):
        with sqlite3.connect((data/'clinical'/(mode+'.db')).as_uri()+'?mode=ro', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
        checks[mode] = {'quick_check':'ok','foreign_keys':0}
    c.point('current', release)
    # No active rollback pointer may select a release that registers AF2.
    c.point('previous', release)
    state.update(af2_retired_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), candidate_image_id=candidate['Id'], gateway_container_id=new['Id'], af2_retirement_integrity=checks, af3_acceptance_receipt=str(pathlib.Path(sys.argv[2])))
    (backup/'deployment.json').write_text(json.dumps(state, indent=2))
    print(json.dumps({'deployed':revision,'af2_route_and_configuration_removed':True,'af2_rollback_target':False,'integrity':checks}), flush=True)

if __name__ == '__main__': main()
