"""Activate a tested immutable Qwen Gateway release; restore config/image on failure."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT=Path('/opt/codex-gateway-r760')
SHARED=ROOT/'shared/config'
CONTAINER='codex_gateway_r760-gateway-1'


def run(args):
    return subprocess.check_output(args,stderr=subprocess.STDOUT).decode()


def inspect(name):
    return json.loads(run(['docker','inspect',name]))[0]


def database_audit(path):
    with sqlite3.connect(f'file:{path}?mode=ro',uri=True) as db:
        db.execute('pragma query_only=on')
        return {'schema':db.execute('select max(version) from schema_migrations').fetchone()[0],'quick_check':db.execute('pragma quick_check').fetchone()[0],'foreign_key_violations':len(db.execute('pragma foreign_key_check').fetchall())}


def point(name,target):
    temporary=ROOT/(name+'.qwen-image-'+str(os.getpid()))
    temporary.symlink_to(target); temporary.replace(ROOT/name)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('revision'); parser.add_argument('expected_current')
    args=parser.parse_args()
    assert re.fullmatch('[0-9a-f]{40}',args.revision)
    release=ROOT/'releases'/args.revision
    assert release.is_dir() and (ROOT/'current').resolve().name==args.expected_current
    current=(ROOT/'current').resolve(); previous=(ROOT/'previous').resolve()
    old=inspect(CONTAINER); image=f'codex_gateway_r760-gateway:{args.revision}'
    assert inspect(image)['Config']['Labels']['org.opencontainers.image.revision']==args.revision
    assert old['Config']['Labels']['org.opencontainers.image.revision']==args.expected_current
    labels=old['Config']['Labels']
    assert labels['com.docker.compose.project.config_files'].split(',')==[str(current/'compose.azure.yml'),str(current/'compose.research-production.yml'),str(SHARED/'compose.r760.override.yml')]
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup=Path('/data/codex-gateway-r760/backups')/('pre-qwen-image-primary-'+stamp)
    backup.mkdir(mode=0o700)
    env=SHARED/'gateway.container.env'; override=SHARED/'compose.r760.override.yml'
    for path in (env,override):
        shutil.copy2(path,backup/path.name); (backup/path.name).chmod(0o600)
        assert hashlib.sha256(path.read_bytes()).digest()==hashlib.sha256((backup/path.name).read_bytes()).digest()
    state={'old_current':str(current),'old_previous':str(previous),'old_image':old['Config']['Image'],'new_revision':args.revision,'backup':str(backup)}
    (backup/'rollback.json').write_text(json.dumps(state,indent=2)+'\n')
    db=next(Path(m['Source'])/'gateway.db' for m in old['Mounts'] if m['Destination']=='/var/lib/codex-gateway')
    before=database_audit(db)
    assert before['quick_check']=='ok' and before['foreign_key_violations']==0
    with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as source,sqlite3.connect(backup/'gateway.db') as target: source.backup(target,pages=2048)
    (backup/'gateway.db').chmod(0o600)
    assert database_audit(backup/'gateway.db')==before
    others={name:inspect(name)['Id'] for name in run(['docker','ps','--format','{{.Names}}']).splitlines() if name!=CONTAINER}
    values={'MEDCODE_IMAGE_PRIMARY_PROVIDER':'qwen','MEDCODE_IMAGE_MODEL_MAP_JSON':'{"medcode-image-default":"qwen-image-2.1"}','MEDCODE_IMAGE_QWEN_API_KEY':(SHARED/'qwen-image.key').read_text().strip(),'MEDCODE_IMAGE_QWEN_BASE_URL':'http://172.18.0.1:18191','MEDCODE_IMAGE_QWEN_TIMEOUT_MS':'180000'}
    old_lines=env.read_text().splitlines()
    lines=[line for line in old_lines if line.split('=',1)[0] not in values]
    lines.extend(key+'='+value for key,value in values.items())
    assert [l for l in old_lines if not l.startswith('MEDCODE_IMAGE_')]==[l for l in lines if not l.startswith('MEDCODE_IMAGE_')]
    candidate=backup/'gateway.container.env.candidate'; candidate.write_text('\n'.join(lines)+'\n'); candidate.chmod(0o600)
    override_text=override.read_text()
    assert override_text.count('image: '+old['Config']['Image'])==1
    changed_override=override_text.replace('image: '+old['Config']['Image'],'image: '+image,1)
    for name in ['gateway.container.env','research.production.api.env','research.production.compose.env','research.production.goldencode.r760.json','research.production.llm-gateway.env','research.production.worker.env']:
        destination=release/'config'/name
        if not destination.exists(): destination.symlink_to(SHARED/name)
        assert destination.resolve()==SHARED/name
    def compose(directory,*command):
        return run(['docker','compose','--env-file',str(SHARED/'research.production.compose.env'),'-p','codex_gateway_r760','-f',str(directory/'compose.azure.yml'),'-f',str(directory/'compose.research-production.yml'),'-f',str(override),'--profile','research-production',*command])
    preflight="""import { validateRuntimeEnvironment } from '/app/apps/gateway/dist/runtime/auth-config.js'; import { createDefaultImageGenerationProvider } from '/app/apps/gateway/dist/runtime/image-providers.js'; validateRuntimeEnvironment(process.env); if(createDefaultImageGenerationProvider(process.env).providerKind!=='qwen-image') throw Error('wrong provider'); const b=process.env.MEDCODE_IMAGE_QWEN_BASE_URL; const h=await fetch(b+'/healthz'); if((await h.json()).status!=='ready') throw Error('Qwen not ready'); const a=await fetch(b+'/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'auth check'})}); if(a.status!==401) throw Error('upstream auth must fail closed');"""
    run(['docker','run','--rm','--network','codex_gateway_r760_default','--env-file',str(candidate),'--entrypoint','node',image,'--input-type=module','-e',preflight])
    compose(release,'config','--quiet')
    changed=False
    try:
        changed=True
        shutil.copy2(candidate,env); env.chmod(0o600)
        override.write_text(changed_override)
        point('previous',current); point('current',release)
        compose(release,'config','--quiet')
        compose(release,'up','-d','--no-build','--no-deps','--force-recreate','gateway')
        for _ in range(60):
            if inspect(CONTAINER)['State'].get('Health',{}).get('Status')=='healthy': break
            time.sleep(4)
        else: raise RuntimeError('Gateway did not become healthy')
        with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health',timeout=20) as response:
            assert json.load(response)['state']=='ready'
        run(['python3',str(release/'scripts/ops/smoke-qwen-image-r760.py'),str(backup)])
        assert all(inspect(name)['Id']==identity for name,identity in others.items())
        after=database_audit(db); assert after==before
        active=inspect(CONTAINER)
        assert active['RestartCount']==0 and active['Config']['Labels']['org.opencontainers.image.revision']==args.revision
        state.update(status='verified',database=after,unrelated_containers_unchanged=True,public_smoke=json.loads((backup/'public-smoke.json').read_text()),verified_utc=datetime.now(timezone.utc).isoformat())
        (backup/'activation.json').write_text(json.dumps(state,indent=2)+'\n')
        print(json.dumps(state,indent=2))
    except BaseException:
        if changed:
            shutil.copy2(backup/env.name,env); shutil.copy2(backup/override.name,override)
            point('current',current); point('previous',previous)
            compose(current,'up','-d','--no-build','--no-deps','--force-recreate','gateway')
        raise


if __name__=='__main__':
    main()
