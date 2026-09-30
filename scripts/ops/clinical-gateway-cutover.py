"""Controlled clinical Gateway rollout on R760 after immutable prepare/build.

Only the Gateway image, named clinical env/mounts and GoldenCode Nginx include
change. Backs up configuration, validates config, drains, verifies public
convergence, and restores/validates the old runtime on any failed cutover.
Usage: python3 clinical-gateway-cutover.py <full-revision>
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request

ROOT = pathlib.Path('/opt/codex-gateway-r760')
CONTAINER = 'codex_gateway_r760-gateway-1'
OVERRIDE = ROOT/'shared/config/compose.r760.override.yml'
VHOST = pathlib.Path('/etc/nginx/sites-available/goldencode-r760.conf')
SECRET = ROOT/'secrets/clinical-star-20261001'

def run(args):
    value = subprocess.run(args, capture_output=True, text=True, timeout=240)
    if value.returncode:
        (BACKUP/'failure.log').write_text(value.stdout+'\n'+value.stderr)
        raise RuntimeError('Command failed; protected failure.log retained: '+str(args[:3]))
    return value.stdout

def inspect(name):
    return json.loads(run(['docker','inspect',name]))[0]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def insert_mounts(block,paths):
    # safe_dump commonly uses indentless sequences; preserve the live style.
    section=re.search(r'(?ms)^    volumes:\n(.*?)(?=^    [A-Za-z_]|\Z)',block)
    assert section, 'Gateway volumes section missing'
    sequence=re.search(r'(?m)^( +)- ',section.group(1)); assert sequence, 'Expected a volume sequence'
    mounts=''.join(sequence.group(1)+'- '+path+'\n' for path in paths)
    return block.replace('    volumes:\n','    volumes:\n'+mounts,1)

def proposed_override(original,old_image,rev,subjects,env):
    match=re.search(r'(?ms)^  gateway:\n.*?(?=^  \S|^\S|\Z)',original); assert match
    block=match.group(); assert block.count('    image: '+old_image+'\n')==1
    config={}
    for mode,port in (('aipal',7444),('panecho',7445)):
        values={'MODE':'pilot','SUBJECT_IDS':subjects,'SQLITE_PATH':'/var/lib/codex-gateway/clinical/'+mode+'.db',
            'STAR_URL':'https://192.168.77.7:'+str(port)+'/internal/'+mode+'/v1','STAR_CA_FILE':'/run/secrets/'+mode+'-ca.pem',
            'STAR_TOKEN_FILE':'/run/secrets/'+mode+'-service.token','DAILY_JOBS':'10','ACTIVE_JOBS':'1','CONTROL_TIMEOUT_MS':'15000','TRANSFER_TIMEOUT_MS':'300000'}
        config.update({'GATEWAY_'+mode.upper()+'_'+k:v for k,v in values.items()})
    present={k:v for k,v in env.items() if k.startswith(('GATEWAY_AIPAL_','GATEWAY_PANECHO_'))}
    if present:
        assert present==config, 'Existing clinical configuration differs from approved settings'
        assert all(k+':' in block for k in config), 'Clinical configuration must remain in the live override'
    else:
        assert 'GATEWAY_AIPAL_' not in block and 'GATEWAY_PANECHO_' not in block
        additions=''.join('      '+k+': '+json.dumps(v)+'\n' for k,v in config.items())
        block=block.replace('    environment:\n','    environment:\n'+additions,1)
        mounts=[str(SECRET/name)+':/run/secrets/'+name+':ro' for mode in ('aipal','panecho') for name in (mode+'-ca.pem',mode+'-service.token')]
        block=insert_mounts(block,mounts)
    block=block.replace('    image: '+old_image+'\n','    image: codex_gateway_r760-gateway:'+rev+'\n')
    return original[:match.start()]+block+original[match.end():]

def proposed_vhost(nginx,release):
    existing=re.findall(r'(?m)^\s*include ([^;\s]+/clinical-location\.conf);\s*$',nginx)
    if existing:
        assert len(existing)==1 and pathlib.Path(existing[0]).read_bytes()==(release/'config/nginx/clinical-location.conf').read_bytes(), 'Existing clinical Nginx route differs'
        return nginx
    assert 'clinical-location.conf' not in nginx
    anchor=re.search(r'^.*include .*imaging-location\.conf;\s*$',nginx,re.M); assert anchor
    include='    include '+(release/'config/nginx/clinical-location.conf').as_posix()+';\n'
    return nginx[:anchor.end()]+'\n'+include+nginx[anchor.end():]

def compose(release):
    return ['docker','compose','--env-file',str(release/'config/research.production.compose.env'),'-p','codex_gateway_r760',
        '-f',str(release/'compose.azure.yml'),'-f',str(release/'compose.research-production.yml'),'-f',str(OVERRIDE),
        '--profile','research-production']

def point(name,target):
    temp=ROOT/('.clinical-'+name); temp.unlink(missing_ok=True); temp.symlink_to(target); os.replace(temp,ROOT/name)

def converge(path):
    deadline=time.monotonic()+60; streak=0; events=[]
    while time.monotonic()<deadline:
        remaining=deadline-time.monotonic()
        try:
            with urllib.request.urlopen('https://goldencode.instmarket.com.au:1443/gateway/health',timeout=min(5,remaining)) as r:
                body=json.load(r); ok=r.status==200 and body.get('state')=='ready' and not body.get('lifecycle',{}).get('draining')
                events.append({'elapsed':round(60-(deadline-time.monotonic()),2),'status':r.status,'ready':ok})
            streak=streak+1 if ok else 0
            if streak==2: path.write_text(json.dumps(events)); return
        except urllib.error.HTTPError as e:
            events.append({'elapsed':round(60-(deadline-time.monotonic()),2),'status':e.code}); streak=0
            if e.code not in (502,503,504): break
        except Exception as e:
            events.append({'elapsed':round(60-(deadline-time.monotonic()),2),'error':type(e).__name__}); streak=0
        time.sleep(min(1,max(0,deadline-time.monotonic())))
    path.write_text(json.dumps(events)); raise RuntimeError('Public convergence failed; evidence retained')

def integrity(meta):
    mount=next(m['Source'] for m in meta['Mounts'] if m['Destination']=='/var/lib/codex-gateway')
    result={}
    for file in ('gateway.db','client-events.db','imaging/control.db','clinical/aipal.db','clinical/panecho.db'):
        path=pathlib.Path(mount)/file
        if not path.exists(): raise RuntimeError('Missing expected database '+file)
        with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as db:
            db.execute('PRAGMA query_only=ON'); quick=db.execute('PRAGMA quick_check').fetchone()[0]; fk=len(db.execute('PRAGMA foreign_key_check').fetchall())
        assert quick=='ok' and fk==0
        result[file]={'quick_check':quick,'foreign_keys':fk}
    return result

def main():
    global BACKUP
    rev=sys.argv[1]; assert re.fullmatch('[a-f0-9]{40}',rev)
    os.umask(0o077); lock=(ROOT/'.deploy.lock').open('a'); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    release=ROOT/'releases'/rev; BACKUP=ROOT/'backups'/('release-'+rev[:12])
    state=json.loads((BACKUP/'deployment.json').read_text()); old=inspect(CONTAINER); previous=(ROOT/'previous').resolve()
    assert old['Id']==state['old_container_id'] and str((ROOT/'current').resolve())==state['old_current'] and sha(OVERRIDE)==state['override_sha256']
    candidate=inspect('codex_gateway_r760-gateway:'+rev); assert candidate['Config']['Labels']['org.opencontainers.image.revision']==rev
    env=dict(x.split('=',1) for x in old['Config']['Env']); subjects=env['GATEWAY_IMAGING_SUBJECT_IDS']
    assert subjects and '*' not in subjects
    original=OVERRIDE.read_text(); nginx=VHOST.read_text(); (BACKUP/'nginx.before.conf').write_text(nginx)
    assert (BACKUP/'previous.override.yml').read_text()==original
    for mode in ('aipal','panecho'):
        for name in (mode+'-ca.pem',mode+'-service.token'):
            p=SECRET/name; st=p.stat(); assert st.st_gid==999 and st.st_mode&0o777==0o440
        assert (SECRET/(mode+'-service.token')).stat().st_size>=32
    proposed=proposed_override(original,state['old_image'],rev,subjects,env)
    proposed_nginx=proposed_vhost(nginx,release)
    (BACKUP/'proposed.override.yml').write_text(proposed); (BACKUP/'nginx.proposed.conf').write_text(proposed_nginx)
    changed=False; drained=False
    try:
        # Validate Compose before touching the running instance.
        preview=compose(release); preview[preview.index(str(OVERRIDE))]=str(BACKUP/'proposed.override.yml')
        run(preview+['config','--quiet'])
        drained=True; run(['python3',str(release/'scripts/ops/gateway-drain.py'),'--container',old['Id'],'--timeout','180'])
        changed=True; OVERRIDE.write_text(proposed); VHOST.write_text(proposed_nginx); run(['nginx','-t'])
        run(compose(release)+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','180','gateway'])
        new=inspect(CONTAINER); assert new['Image']==candidate['Id'] and new['RestartCount']==0 and new['State']['Health']['Status']=='healthy'
        assert new['HostConfig']['PortBindings']==old['HostConfig']['PortBindings']
        old_env=set(old['Config']['Env']); new_env=set(new['Config']['Env']); delta={x.split('=',1)[0] for x in old_env^new_env}
        assert all(k.startswith(('GATEWAY_AIPAL_','GATEWAY_PANECHO_')) for k in delta), 'Unexpected environment change'
        old_mounts={m['Destination']:m for m in old['Mounts']}; new_mounts={m['Destination']:m for m in new['Mounts']}
        assert all(new_mounts[k]['Source']==v['Source'] and new_mounts[k]['RW']==v['RW'] for k,v in old_mounts.items())
        for name,cid in state['others'].items(): assert inspect(name)['Id']==cid
        run(['systemctl','reload','nginx']); converge(BACKUP/'public-convergence.json')
        checks=integrity(new)
        # Capabilities prove both private TLS/auth configuration paths through public routing.
        command="import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.GATEWAY_SQLITE_PATH,{readOnly:true}); db.exec('PRAGMA query_only=ON'); console.log(db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v);"
        schema=int(run(['docker','exec',CONTAINER,'node','--input-type=module','-e',command]).strip())
        point('previous',state['old_current']); point('current',release)
        state.update(clinical_deployed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),candidate_image_id=candidate['Id'],gateway_container_id=new['Id'],schema_version=schema,clinical_integrity=checks)
        (BACKUP/'deployment.json').write_text(json.dumps(state,indent=2))
        print(json.dumps({'deployed':rev,'previous':state['previous_revision'],'schema':schema,'integrity':checks,'pilot_count':len(subjects.split(','))}))
    except BaseException:
        OVERRIDE.write_text(original); VHOST.write_text(nginx)
        if changed:
            run(compose(pathlib.Path(state['old_current']))+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','180','gateway'])
            run(['nginx','-t']); run(['systemctl','reload','nginx']); converge(BACKUP/'rollback-convergence.json')
            assert inspect(CONTAINER)['Image']==old['Image']; point('current',state['old_current']); point('previous',previous)
        elif drained: run(['python3',str(release/'scripts/ops/gateway-drain.py'),'--container',old['Id'],'--resume','--timeout','30']); converge(BACKUP/'abort-convergence.json')
        raise

if __name__=='__main__': main()
