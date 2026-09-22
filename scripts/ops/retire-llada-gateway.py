"""Config-only retirement of the LLaDA fallback; retain immutable Gateway image."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path('/opt/codex-gateway-r760')
SHARED = ROOT/'shared/config'
CONTAINER = 'codex_gateway_r760-gateway-1'


def run(args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('expected_current')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    current = (ROOT/'current').resolve()
    assert current.name == args.expected_current
    container = inspect(CONTAINER)
    compose_files = [str(current/'compose.azure.yml'), str(current/'compose.research-production.yml'), str(SHARED/'compose.r760.override.yml')]
    assert container['Config']['Labels']['com.docker.compose.project.config_files'].split(',') == compose_files
    assert container['Config']['Labels']['org.opencontainers.image.revision'] == args.expected_current
    def compose(*command):
        base = ['docker','compose','--env-file',str(SHARED/'research.production.compose.env'),'-p','codex_gateway_r760']
        for file in compose_files:
            base.extend(['-f',file])
        return run(base+['--profile','research-production',*command])
    env = SHARED/'gateway.container.env'
    def activate():
        compose('config','--quiet')
        compose('up','-d','--no-build','--no-deps','--force-recreate','gateway')
        for _ in range(60):
            if inspect(CONTAINER)['State'].get('Health',{}).get('Status') == 'healthy':
                return
            time.sleep(3)
        raise RuntimeError('Gateway health timeout')
    if args.rollback:
        shutil.copy2(args.rollback/env.name,env)
        activate()
        print(json.dumps({'restored':str(args.rollback)}))
        return
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/data/codex-gateway-r760/backups')/('pre-retire-llada-'+stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(env,backup/env.name)
    assert hashlib.sha256(env.read_bytes()).digest() == hashlib.sha256((backup/env.name).read_bytes()).digest()
    old = env.read_text().splitlines()
    changed = [line for line in old if not line.startswith('MEDCODE_IMAGE_LLADA_')]
    assert len(changed) < len(old)
    assert [l for l in old if not l.startswith('MEDCODE_IMAGE_')] == [l for l in changed if not l.startswith('MEDCODE_IMAGE_')]
    candidate = backup/'gateway.container.env.candidate'
    candidate.write_text('\n'.join(changed)+'\n'); candidate.chmod(0o600)
    others = {n:inspect(n)['Id'] for n in run(['docker','ps','--format','{{.Names}}']).splitlines() if n != CONTAINER}
    db_path = next(Path(m['Source'])/'gateway.db' for m in container['Mounts'] if m['Destination']=='/var/lib/codex-gateway')
    with sqlite3.connect(f'file:{db_path}?mode=ro',uri=True) as db, sqlite3.connect(backup/'gateway.db') as target:
        db.execute('pragma query_only=on')
        db.backup(target)
        assert db.execute('pragma quick_check').fetchone()[0]=='ok'
        assert not db.execute('pragma foreign_key_check').fetchall()
        assert target.execute('pragma quick_check').fetchone()[0]=='ok'
        assert not target.execute('pragma foreign_key_check').fetchall()
    (backup/'gateway.db').chmod(0o600)
    preflight="""import {createDefaultImageGenerationProvider,resolveImageGenerationBillingFallbacks} from '/app/apps/gateway/dist/runtime/image-providers.js'; const p=createDefaultImageGenerationProvider(process.env); const f=resolveImageGenerationBillingFallbacks({},process.env,{info:()=>{}}); if(p.providerKind!=='qwen-image'||f.some(x=>x.provider.providerKind==='llada-image')||f[0].upstreamModel!=='gpt-image-2')throw Error('Unexpected image chain'); console.log(JSON.stringify({primary:p.providerKind,fallbacks:f.map(x=>x.upstreamModel)}));"""
    check = ['docker','run','--rm','--network','codex_gateway_r760_default','--env-file',str(candidate)]
    # Extra cloud fallback credentials are a runtime file, not image contents.
    # Mount only that existing file read-only for the isolated configuration check.
    config = dict(line.split('=',1) for line in changed if '=' in line and not line.startswith('#'))
    fallback_file = config.get('MEDCODE_IMAGE_BILLING_FALLBACK_KEYS_FILE')
    if fallback_file:
        mount = next(m for m in container['Mounts'] if fallback_file == m['Destination'] or fallback_file.startswith(m['Destination'].rstrip('/')+'/'))
        source = Path(mount['Source'])/Path(fallback_file).relative_to(mount['Destination'])
        assert source.is_file()
        check.extend(['--mount',f'type=bind,src={source},dst={fallback_file},readonly'])
    chain = json.loads(run(check+['--entrypoint','node',container['Config']['Image'],'--input-type=module','-e',preflight]))
    print(json.dumps({'phase':'backed-up','backup':str(backup),'chain':chain}),flush=True)
    try:
        shutil.copy2(candidate,env)
        activate()
        with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health',timeout=15) as r:
            assert json.load(r)['state']=='ready'
        assert all(inspect(n)['Id']==identity for n,identity in others.items())
        active=inspect(CONTAINER)
        assert active['Config']['Image']==container['Config']['Image'] and active['RestartCount']==0
        receipt={'backup':str(backup),'gateway_revision':args.expected_current,'chain':chain,'unrelated_containers_unchanged':True,'verified_utc':datetime.now(timezone.utc).isoformat()}
        (backup/'activation.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps(receipt,indent=2))
    except BaseException:
        shutil.copy2(backup/env.name,env)
        activate()
        raise


if __name__=='__main__':
    main()
