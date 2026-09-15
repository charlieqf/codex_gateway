#!/usr/bin/env python3
"""Activate a tested Gateway-only phone-enrollment release; schema remains 30.

Run prepare-phone-signup-r760.py first, then build the pinned release with
r760-phone-signup.Dockerfile. This script changes only the Gateway image in the
existing override, preserves the shared Worker image tag, and restores the old
image/configuration on failed activation without restoring live databases.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, shutil, sqlite3, stat, subprocess, sys, time, urllib.request
import yaml

rev = sys.argv[1]
assert re.fullmatch(r'[0-9a-f]{40}', rev)
arguments=set(sys.argv[2:])
assert len(arguments)==len(sys.argv[2:]) and arguments <= {'--restart-with-active-requests','--medevidence-min-beta76'}
restart_with_active_requests = '--restart-with-active-requests' in arguments
activate_medevidence_minimum = '--medevidence-min-beta76' in arguments
flags = ({
    'GATEWAY_DESKTOP_VERSION_GATE':'medevidence_all',
    'GATEWAY_MINIMUM_DESKTOP_VERSION':'2.0.0-beta.76',
    'GATEWAY_DESKTOP_DOWNLOAD_URL':'https://updates.instmarket.com.au/desktop-updates/beta/medevidence-desktop-win-x64.exe',
} if activate_medevidence_minimum else {})
root = pathlib.Path('/opt/codex-gateway-r760')
release = root/'releases'/rev
backup = root/'backups'/('phone-signup-'+rev[:12])
override = root/'shared/config/compose.r760.override.yml'
container = 'codex_gateway_r760-gateway-1'
image = 'codex_gateway_r760-gateway:'+rev
os.umask(0o077)
lock=(root/'.deploy.lock').open('a'); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
state=json.loads((backup/'deployment.json').read_text())
def sha(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def command(args):
    result=subprocess.run(args,capture_output=True,text=True)
    if result.returncode:
        (backup/'activation-command-failure.log').write_text(result.stdout+'\n'+result.stderr)
        raise RuntimeError('Command failed; protected diagnostic saved')
    return result.stdout
def inspect(name): return json.loads(command(['docker','inspect',name]))[0]
def emit(**value): print(json.dumps(value),flush=True)
def env_sha(meta): return hashlib.sha256('\n'.join(sorted(meta['Config']['Env'])).encode()).hexdigest()
def compose(path, directory=release):
    return ['docker','compose','--env-file',state['compose_env_file'],'-p','codex_gateway_r760',
        '-f',str(directory/'compose.azure.yml'),'-f',str(directory/'compose.research-production.yml'),
        '-f',str(path),'--profile','research-production']
def point(name,target):
    temp=root/('.phone-enrollment-'+name)
    assert not temp.exists() and not temp.is_symlink()
    temp.symlink_to(target);os.replace(temp,root/name)
def write_state():
    (backup/'deployment.json').write_text(json.dumps(state,indent=2)+'\n')
def readonly(path):
    db=sqlite3.connect(pathlib.Path(path).as_uri()+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON');return db

meta=inspect(container)
assert meta['Id']==state['old_container_id'] and str((root/'current').resolve())==state['old_current']
assert env_sha(meta)==state['env_sha256']
expected_env=dict(item.split('=',1) for item in meta['Config']['Env'])
expected_env.update(flags)
expected_env_sha=hashlib.sha256('\n'.join(sorted(k+'='+v for k,v in expected_env.items())).encode()).hexdigest()
for path,digest in state['config_sha256'].items(): assert sha(path)==digest,'Configuration changed since prepare'
for name,identity in state['others'].items(): assert inspect(name)['Id']==identity
for name in ['compose.azure.yml','compose.research-production.yml']:
    assert sha(release/name)==sha(pathlib.Path(state['old_current'])/name),'Compose source changed'
candidate=inspect(image)
assert candidate['Config']['Labels']['org.opencontainers.image.revision']==rev
state['candidate_image_id']=candidate['Id']
buildlog=root/'staging'/rev/'build.log'
shutil.copy2(buildlog,backup/'build.log')
buildtext=buildlog.read_text(errors='replace')
assert ('exporting to image' in buildtext or ('Successfully built' in buildtext and 'Successfully tagged' in buildtext)), 'Completed build log required'

original=override.read_text()
pattern=r'(?ms)^  gateway:\s*\n.*?(?=^  [A-Za-z0-9_-]+:\s*\n|^[^\s#][^\n]*:\s*\n|\Z)'
match=re.search(pattern,original);assert match
block,count=re.subn(r'(?m)^    image:.*$',lambda _: '    image: '+image,match.group())
assert count==1
if flags:
    environment=yaml.safe_load(block).get('gateway',{}).get('environment',{}) or {}
    assert not set(flags)&set(environment), 'Version-gate flags already exist in the override'
    env_lines=''.join('      '+key+': "'+value+'"\n' for key,value in flags.items())
    if re.search(r'(?m)^    environment:\s*$',block):
        block=re.sub(r'(?m)^    environment:\s*$',lambda _: '    environment:\n'+env_lines.rstrip('\n'),block,count=1)
    else:
        block=block.rstrip('\n')+'\n    environment:\n'+env_lines
proposed=original[:match.start()]+block+original[match.end():]
expected=yaml.safe_load(original);expected['services']['gateway']['image']=image
expected['services']['gateway'].setdefault('environment',{}).update(flags)
assert yaml.safe_load(proposed)==expected
proposed_path=backup/'proposed.override.yml';proposed_path.write_text(proposed)
command(compose(proposed_path)+['config','--quiet'])
# Inspect rendered config in memory only to validate release-local secret symlinks.
effective=json.loads(command(compose(proposed_path)+['config','--format','json']))
mounts={m['Destination']:m['Source'] for m in meta['Mounts']}
for item in effective['services']['gateway'].get('secrets',[]):
    target='/run/secrets/'+item.get('target',item['source'])
    source=pathlib.Path(mounts[target]);destination=pathlib.Path(effective['secrets'][item['source']]['file'])
    assert source.is_file() and stat.S_IMODE(source.stat().st_mode)&0o007==0
    if not destination.exists():
        assert destination.parent==release/'secrets' and not destination.is_symlink()
        destination.parent.mkdir(mode=0o700,exist_ok=True);destination.symlink_to(source.resolve())
    assert destination.resolve()==source.resolve()
assert effective['services']['gateway']['image']==image
for key,value in flags.items(): assert effective['services']['gateway']['environment'][key]==value
dbpath=pathlib.Path(mounts['/var/lib/codex-gateway'])/'gateway.db'
with readonly(dbpath) as db:
    assert db.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0]==30
    last_pending=None
    for attempt in range(151):
        pending=db.execute('SELECT COUNT(*) FROM token_reservations WHERE finalized_at IS NULL').fetchone()[0]
        if pending==0: break
        if restart_with_active_requests:
            emit(event='authorized_service_restart_with_active_requests',pending=pending)
            break
        if attempt==150: raise RuntimeError('Active requests remain; no activation performed')
        if pending!=last_pending or attempt%15==0: emit(event='waiting_for_requests',pending=pending)
        last_pending=pending;time.sleep(2)
state['cutover_started_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();write_state()
changed=False
try:
    # Refresh Gateway control backup immediately before the authorized service cutover.
    fresh=backup/'gateway-pre-cutover.db'
    with readonly(dbpath) as db,sqlite3.connect(fresh) as copy: db.backup(copy,pages=1024,sleep=0.05)
    with readonly(fresh) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
    state['pre_cutover_backup_sha256']=sha(fresh);write_state();emit(event='cutover_backup_verified')
    with readonly(dbpath) as db:
        state['requests_pending_before_stop']=[row[0] for row in db.execute('SELECT request_id FROM token_reservations WHERE finalized_at IS NULL')]
    state['restart_with_active_requests']=restart_with_active_requests;write_state()
    command(['docker','stop','--time','30',container])
    changed=True
    temp=override.with_suffix('.phone-enrollment.tmp');assert not temp.exists()
    shutil.copyfile(proposed_path,temp);os.chmod(temp,stat.S_IMODE(override.stat().st_mode));os.replace(temp,override)
    command(compose(override)+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','120','gateway'])
    current=inspect(container)
    assert current['Image']==candidate['Id'] and current['RestartCount']==0 and current['State']['Health']['Status']=='healthy'
    assert env_sha(current)==expected_env_sha and current['HostConfig']['PortBindings']==meta['HostConfig']['PortBindings']
    for name,identity in state['others'].items(): assert inspect(name)['Id']==identity
    with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health',timeout=20) as response:
        assert json.load(response)['state']=='ready'
    point('previous',state['old_current']);point('current',str(release))
    state.update(deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),gateway_started_at=current['State']['StartedAt'],
        gateway_container_id=current['Id'],expected_env_sha256=expected_env_sha,
        medevidence_minimum_version_flags=flags,
        expected_config_sha256={**state['config_sha256'],str(override):sha(override)},other_containers_unchanged=True)
    write_state();changed=False
    emit(event='activated',revision=rev,image_id=current['Image'],health='healthy',restarts=0,
        other_containers_unchanged=True,environment_unchanged=not flags,
        medevidence_minimum_version='2.0.0-beta.76' if flags else None,
        backup=str(backup),deployed_at=state['deployed_at'])
finally:
    if changed:
        shutil.copyfile(backup/override.name,override)
        point('current',state['old_current']);point('previous',state['old_previous'])
        command(compose(override,pathlib.Path(state['old_current']))+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','120','gateway'])
        emit(event='old_gateway_restored_without_database_restore')
