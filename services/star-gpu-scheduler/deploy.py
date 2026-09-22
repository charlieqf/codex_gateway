"""Controlled star-only rollout from committed, extracted release artifacts.

No inference requests. 'activate' keeps business APIs stopped until 'open'.
Rollback isolates Qwen to GPU0; it never restores LLaDA or rewinds databases.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import time
import urllib.request

BASE=Path('/data/apps/star-gpu-scheduler')
QWEN=Path('/data/apps/qwen-image-21-eval')
RADAR=Path('/data/apps/radar-imaging')
UNITS=Path.home()/'.config/systemd/user'
SERVICES=['qwen-image-pool.service','qwen-image-worker@0.service','qwen-image-worker@1.service','radar-imaging.service']


def run(*args, timeout=60):
    return subprocess.check_output(list(args),text=True,stderr=subprocess.STDOUT,timeout=timeout).strip()


def ctl(*args, timeout=210): return run('systemctl','--user',*args,timeout=timeout)


def protected(path, text):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as stream: stream.write(text)


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def health(port):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/healthz',timeout=8) as response:
        return json.load(response)


def current():
    return {'qwen':str((QWEN/'current').resolve()),'radar':str((RADAR/'current').resolve())}


def verify_idle():
    pool=health(8191)
    assert pool['active']==0 and pool['queued']==0,'Qwen is not drained'
    for port in (8200,8201): assert health(port)['busy'] is False,'Qwen worker is busy'
    with sqlite3.connect('file:'+str(RADAR/'data/execution.sqlite')+'?mode=ro',uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        count=db.execute("SELECT count(*) FROM resources WHERE state IN ('validating','queued','preprocessing','running','postprocessing','cancel_requested')").fetchone()[0]
    assert count==0,'RADAR has pending work; wait before rollout'


def operator(action):
    return json.loads(run(str(BASE/'env/bin/python'),'-I','-m','star_gpu_scheduler.operator',
        '--config',str(BASE/'config/service.json'),action))


def link(target, location):
    temp=location.with_name(location.name+'.scheduler-next')
    assert not temp.exists() and not temp.is_symlink()
    temp.symlink_to(target)
    temp.replace(location)


def prepare(manifest):
    assert current()==manifest['expected_current'],'Live release drift'
    for filename,expected in manifest['expected_hashes'].items():
        assert sha(filename)==expected,'Live source drift: '+filename
    verify_idle()
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=BASE/'backups'/('pre-'+stamp)
    backup.mkdir(parents=True,mode=0o700)
    for name in ('units','config'): (backup/name).mkdir(mode=0o700)
    details={'current':current(),'states':{},'prepared_at':stamp,'manifest':manifest}
    for name in SERVICES:
        details['states'][name]=ctl('show',name,'-p','ActiveState','-p','MainPID','-p','UnitFileState')
    for name in ('qwen-image-pool.service','qwen-image-worker@.service','radar-imaging.service'):
        shutil.copy2(UNITS/name,backup/'units'/name)
    shutil.copy2(QWEN/'api.env',backup/'config/qwen-api.env')
    shutil.copytree(RADAR/'config',backup/'config/radar')
    source=sqlite3.connect('file:'+str(RADAR/'data/execution.sqlite')+'?mode=ro',uri=True)
    dest=sqlite3.connect(backup/'radar.sqlite')
    source.backup(dest)
    assert dest.execute('PRAGMA quick_check').fetchone()[0]=='ok'
    dest.close();source.close()
    protected(backup/'receipt.json',json.dumps(details,indent=2))
    hashes={str(p.relative_to(backup)):sha(p) for p in backup.rglob('*') if p.is_file()}
    protected(backup/'sha256.json',json.dumps(hashes,indent=2))
    for path,expected in hashes.items(): assert sha(backup/path)==expected
    for p in backup.rglob('*'): os.chmod(p,0o700 if p.is_dir() else 0o600)
    for name in ('config','state'): (BASE/name).mkdir(parents=True,exist_ok=True,mode=0o700)
    roles=('qwen_pool','qwen_worker_0','qwen_worker_1','radar_service','radar_runner','operator')
    files={role:str(BASE/'config'/(role+'.token')) for role in roles}
    for path in files.values():
        if not Path(path).exists(): protected(path,secrets.token_urlsafe(48)+'\n')
        assert Path(path).stat().st_mode & 0o777==0o600
    config={'runtime_directory':'/run/user/'+str(os.getuid())+'/star-gpu-arbiter',
        'database':str(BASE/'state/scheduler.sqlite'),'mode':'enforce','host_reserve_mib':12288,
        'token_files':files,'units':{'qwen_pool':'qwen-image-pool.service',
            'qwen_worker_0':'qwen-image-worker@0.service','qwen_worker_1':'qwen-image-worker@1.service',
            'radar_service':'radar-imaging.service','indextts':'indextts2.service'}}
    config_path=BASE/'config/service.json'
    if config_path.exists():
        assert json.loads(config_path.read_text())==config,'Existing scheduler configuration differs'
    else:
        protected(config_path,json.dumps(config,indent=2))
    if not (BASE/'env/bin/python').exists():
        run('python3','-m','venv',str(BASE/'env'))
    for python in (BASE/'env/bin/python',QWEN/'env/bin/python',Path('/data/apps/radar-poc/.venv/bin/python')):
        # RADAR's uv-created environment deliberately has no pip. Use the existing
        # Qwen pip driver to target it, without adding/updating model dependencies.
        run(str(QWEN/'env/bin/python'),'-m','pip','--python',str(python),
            'install','--no-index','--no-deps','--force-reinstall',manifest['wheel'])
        assert run(str(python),'-I','-c','import star_gpu_scheduler; print(star_gpu_scheduler.__version__)')=='0.1.0'
    protected(BASE/'state/prepared.json',json.dumps({'backup':str(backup),'manifest':manifest},indent=2))
    print(json.dumps({'prepared':True,'backup':str(backup)}),flush=True)


def activate(prepared):
    manifest=prepared['manifest']
    assert current()==manifest['expected_current']
    verify_idle()
    ctl('stop','radar-imaging.service')
    ctl('stop','qwen-image-pool.service')
    for port in (8200,8201): assert health(port)['busy'] is False
    ctl('stop','qwen-image-worker@0.service','qwen-image-worker@1.service')
    for name in SERVICES: assert 'ActiveState=inactive' in ctl('show',name,'-p','ActiveState')
    qwen=Path(manifest['qwen_release'])
    radar=Path(manifest['radar_release'])
    scheduler=qwen/'services/star-gpu-scheduler'
    for name in ('qwen-image-pool.service','qwen-image-worker@.service'):
        shutil.copy2(qwen/'scripts/experiments/qwen-image-21-eval'/name,UNITS/name)
    shutil.copy2(scheduler/'star-gpu-scheduler.service',UNITS/'star-gpu-scheduler.service')
    deployment=(radar/'deploy.sh').read_text()
    unit=deployment.split("<<'UNIT'\n",1)[1].split('\nUNIT',1)[0]+'\n'
    (UNITS/'radar-imaging.service').write_text(unit)
    link(qwen,QWEN/'current');link(radar,RADAR/'current')
    ctl('daemon-reload')
    ctl('enable','star-gpu-scheduler.service',*SERVICES)
    ctl('start','star-gpu-scheduler.service')
    deadline=time.monotonic()+45
    while True:
        try:
            if operator('status')['ready']: break
        except Exception: pass
        assert time.monotonic()<deadline,'Broker did not become ready; business APIs remain stopped'
        time.sleep(1)
    operator('resume')
    ctl('start','qwen-image-worker@0.service','qwen-image-worker@1.service')
    deadline=time.monotonic()+600
    previous=None
    while True:
        states=[]
        for port in (8200,8201):
            try: states.append(health(port)['status'])
            except Exception: states.append('starting')
        if states!=previous:
            print(json.dumps({'workers':states,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}),flush=True)
            previous=states
        if states==['ready','ready']: break
        assert time.monotonic()<deadline,'Initialization not ready; business APIs remain stopped'
        time.sleep(2)
    status=operator('status')
    assert status['ready'] and not any(status['counts'].values())
    print(json.dumps({'activated':True,'business_apis':'stopped','current':current()}),flush=True)


def open_services(prepared):
    status=operator('status')
    assert status['ready'] and status['mode']=='enforce' and status['drain']==''
    assert current()=={'qwen':prepared['manifest']['qwen_release'],'radar':prepared['manifest']['radar_release']}
    for port in (8200,8201): assert health(port)['status']=='ready'
    ctl('start','radar-imaging.service','qwen-image-pool.service')
    for name in SERVICES: assert ctl('is-active',name)=='active'
    print(json.dumps({'opened_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'current':current()}),flush=True)


def rollback(prepared):
    # Stop intake first; broker-owned jobs must drain before any old code starts.
    try: operator('drain')
    except Exception: pass
    ctl('stop','qwen-image-pool.service','radar-imaging.service')
    ctl('stop','qwen-image-worker@0.service','qwen-image-worker@1.service')
    ctl('stop','star-gpu-scheduler.service')
    assert not run('systemctl','--user','list-units','--plain','--no-legend','--state=active','radar-task-*.service')
    backup=Path(prepared['backup'])
    for name in ('qwen-image-pool.service','qwen-image-worker@.service','radar-imaging.service'):
        shutil.copy2(backup/'units'/name,UNITS/name)
    pool=UNITS/'qwen-image-pool.service'
    pool.write_text(pool.read_text().replace(' qwen-image-worker@1.service',''))
    previous=prepared['manifest']['expected_current']
    link(previous['qwen'],QWEN/'current');link(previous['radar'],RADAR/'current')
    ctl('daemon-reload')
    ctl('disable','qwen-image-worker@1.service','star-gpu-scheduler.service')
    ctl('start','qwen-image-worker@0.service','radar-imaging.service')
    deadline=time.monotonic()+480
    while True:
        try:
            if health(8200)['status']=='ready': break
        except Exception: pass
        assert time.monotonic()<deadline
        time.sleep(2)
    ctl('start','qwen-image-pool.service')
    print(json.dumps({'rolled_back':True,'qwen_gpu':0,'radar_gpu':1,'database':'preserved'}),flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=('prepare','activate','open','rollback'))
    parser.add_argument('--manifest')
    args=parser.parse_args()
    assert run('hostname')=='star' and run('id','-un')=='aiuser'
    os.umask(0o077)
    if args.action=='prepare':
        manifest=json.loads(Path(args.manifest).read_text())
        for key,base in (('qwen_release',QWEN),('radar_release',RADAR)):
            path=Path(manifest[key]).resolve()
            assert path.parent==base/'releases' and re.fullmatch('[a-f0-9]{40}',path.name)
        assert sha(manifest['wheel'])==manifest['wheel_sha256']
        prepare(manifest)
    else:
        prepared=json.loads((BASE/'state/prepared.json').read_text())
        {'activate':activate,'open':open_services,'rollback':rollback}[args.action](prepared)


if __name__=='__main__': main()
