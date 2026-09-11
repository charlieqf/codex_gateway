#!/usr/bin/env python3
"""Prepare or activate a tested immutable Research/Gateway release on R760.

prepare REV SOURCE_SHA BUILD_SHA EXPECTED_GATEWAY_IMAGE EXPECTED_WORKER_IMAGE OVERRIDE_SHA
activate REV
No credentials or rendered Compose configuration are printed.
"""
import datetime, hashlib, json, os, pathlib, re, shutil, sqlite3, stat, subprocess, sys, tarfile
import yaml

root = pathlib.Path('/opt/codex-gateway-r760')
mode, revision = sys.argv[1:3]
assert mode in ('prepare', 'activate') and re.fullmatch('[a-f0-9]{40}', revision)
release = root/'releases'/revision
backup = root/'backups'/('research-practical-'+revision[:12])
override = root/'shared/config/compose.r760.override.yml'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def command(args, **kwargs):
    p = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if p.returncode:
        (backup/'command-failure.log').write_text(p.stdout+'\n'+p.stderr)
        os.chmod(backup/'command-failure.log', 0o600)
        raise RuntimeError(args[0]+' failed; protected diagnostic saved')
    return p.stdout
def inspect(service): return json.loads(command(['docker','inspect','codex_gateway_r760-'+service+'-1']))[0]
def mounts(container): return {m['Destination']:m['Source'] for m in container['Mounts']}
def emit(**value): print(json.dumps(value), flush=True)
def compose(overlay):
    return ['docker','compose','--env-file',state['compose_env'],'-p','codex_gateway_r760',
        '-f',str(release/'compose.azure.yml'),'-f',str(release/'compose.research-production.yml'),
        '-f',str(overlay),'--profile','research-production']
def read_db(p):
    d=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True); d.execute('PRAGMA query_only=ON'); return d
def check_db(d):
    assert d.execute('PRAGMA quick_check').fetchone()[0]=='ok'
    assert not d.execute('PRAGMA foreign_key_check').fetchall()
def unfinished():
    with read_db(state['research_db']) as d:
        return d.execute("SELECT count(*) FROM research_runs WHERE status IN ('queued','running','needs_input')").fetchone()[0]
def replace_service(text, name, value):
    pattern = r'(?ms)^  '+re.escape(name)+r':\s*\n.*?(?=^  [A-Za-z0-9_-]+:\s*\n|^[^\s#][^\n]*:\s*\n|\Z)'
    block = ''.join('  '+line+'\n' for line in yaml.safe_dump({name:value},sort_keys=False).splitlines())
    updated, count = re.subn(pattern, lambda _: block, text)
    assert count == 1, 'Expected one existing service block'
    return updated

if mode == 'prepare':
    source_hash, build_hash, gateway_image, worker_image, override_hash = sys.argv[3:]
    assert all(re.fullmatch('[a-f0-9]{64}', h) for h in [source_hash,build_hash,override_hash])
    assert all(re.fullmatch('sha256:[a-f0-9]{64}', h) for h in [gateway_image,worker_image])
    backup.mkdir(mode=0o700,exist_ok=False)
    gateway, worker = inspect('gateway'), inspect('research-worker')
    assert gateway['Image']==gateway_image and worker['Image']==worker_image and sha(override)==override_hash
    assert gateway['State']['Health']['Status']=='healthy' and worker['State']['Health']['Status']=='healthy'
    state={'revision':revision,'gateway_id':gateway['Id'],'worker_id':worker['Id'],
        'old_gateway_image':gateway_image,'old_worker_image':worker_image,'override_sha256':override_hash,
        'old_current':str((root/'current').resolve()),'old_previous':str((root/'previous').resolve()),
        'compose_env':gateway['Config']['Labels']['com.docker.compose.project.environment_file'],
        'research_db':str(pathlib.Path(mounts(worker)['/var/lib/codex-gateway-research'])/'research.db'),
        'source_archive_sha256':source_hash,'build_archive_sha256':build_hash,
        'unrelated':{name:inspect(name)['Id'] for name in ['research-maintenance','research-llm-gateway']}}
    assert unfinished()==0
    release.mkdir(mode=0o755,exist_ok=False)
    for kind,digest in [('source',source_hash),('build',build_hash)]:
        archive=pathlib.Path('/tmp')/('research-practical-'+revision+'-'+kind+'.tgz')
        assert sha(archive)==digest
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                assert (release/member.name).resolve().is_relative_to(release) and not member.issym() and not member.islnk()
            bundle.extractall(release,filter='data')
    build_manifest=json.loads((release/'research-release-build.json').read_text())
    assert build_manifest['revision']==revision
    assert all(sha(release/name)==digest for name,digest in build_manifest['files'].items())
    for name in ['compose.azure.yml','compose.research-production.yml']:
        assert sha(release/name)==sha(pathlib.Path(state['old_current'])/name)
    for p in (pathlib.Path(state['old_current'])/'config').iterdir():
        if p.is_symlink() and p.resolve().is_relative_to(root/'shared'):
            target=release/'config'/p.name
            assert not target.exists() and not target.is_symlink()
            target.symlink_to(p.resolve())
    for p in [override,pathlib.Path(state['compose_env'])]:
        assert p.stat().st_uid==0 and stat.S_IMODE(p.stat().st_mode)&0o022==0
        if p.suffix=='.env': assert stat.S_IMODE(p.stat().st_mode)&0o077==0
        shutil.copy2(p,backup/p.name); os.chmod(backup/p.name,0o600)
        assert sha(p)==sha(backup/p.name)
    for p in worker['Mounts']+gateway['Mounts']:
        if p['Destination'].startswith('/run/secrets/'):
            assert stat.S_IMODE(pathlib.Path(p['Source']).stat().st_mode)&0o007==0
    image='codex-gateway-research-practical:'+revision
    command(['docker','build','--build-arg','BASE_GATEWAY_IMAGE='+gateway_image,'--build-arg','RELEASE_REVISION='+revision,
        '-f',str(release/'deploy/r760-research-practical.Dockerfile'),'-t',image,str(release)])
    built=json.loads(command(['docker','image','inspect',image]))[0]
    assert built['Config']['Labels']['org.opencontainers.image.revision']==revision
    state.update(image=image,image_id=built['Id'])
    original=override.read_text(); config=yaml.safe_load(original)
    updates={name:dict(config['services'][name]) for name in ['gateway','research-worker']}
    for value in updates.values(): value['image']=image; value['environment']=dict(value.get('environment',{}))
    updates['gateway']['environment']['RESEARCH_IDENTITY_AGENT_ENABLED']='true'
    worker_flags={'RESEARCH_IDENTITY_AGENT_ENABLED':'true','RESEARCH_PRACTICAL_PROFILE_ENABLED':'true',
        'RESEARCH_IDENTITY_MAX_SEARCH_REQUESTS':'2','RESEARCH_IDENTITY_MAX_PAGE_REQUESTS':'12','RESEARCH_IDENTITY_MAX_MODEL_CALLS':'8',
        'RESEARCH_MAX_LLM_CALLS_PER_RUN':'14','RESEARCH_MAX_INPUT_TOKENS_PER_CALL':'40000','RESEARCH_MAX_OUTPUT_TOKENS_PER_CALL':'6000',
        'RESEARCH_MAX_INPUT_TOKENS_PER_RUN':'1000000','RESEARCH_MAX_OUTPUT_TOKENS_PER_RUN':'300000',
        'RESEARCH_MAX_EXTERNAL_REQUESTS_PER_RUN':'1000','RESEARCH_MAX_EXTERNAL_BYTES_PER_RUN':'2000000000',
        'RESEARCH_MAX_CHECKPOINT_BYTES':'1000000','RESEARCH_DOCTOR_LOOKUP_BRIEF_ENABLED':'false','RESEARCH_SYNTHESIS_SHARD_COUNT':'1',
        'RESEARCH_WORKER_VERSION':'research-practical-'+revision[:12]}
    updates['research-worker']['environment'].update(worker_flags)
    proposed=original
    for name,value in updates.items(): proposed=replace_service(proposed,name,value)
    parsed=yaml.safe_load(proposed)
    expected=yaml.safe_load(original)
    for name,value in updates.items(): expected['services'][name]=value
    assert parsed==expected
    proposed_path=backup/'proposed.override.yml'; proposed_path.write_text(proposed); os.chmod(proposed_path,0o600)
    command(compose(proposed_path)+['config','--quiet'])
    private_env=backup/'preflight.private.env'
    env=dict(item.split('=',1) for item in worker['Config']['Env']); env.update(worker_flags)
    assert all('\n' not in str(v) and '\r' not in str(v) for v in env.values())
    private_env.write_text(''.join(k+'='+str(v)+'\n' for k,v in env.items())); os.chmod(private_env,0o600)
    try:
        args=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--env-file',str(private_env)]
        for m in worker['Mounts']: args+=['--mount','type=bind,src='+m['Source']+',dst='+m['Destination']+',readonly']
        args += ['-i',image,'node','--input-type=module','-']
        code="import {loadResearchWorkerConfig} from '/app/apps/research-worker/dist/config.js'; const c=loadResearchWorkerConfig(process.env); if(!c.workflowPolicy.identityAgentEnabled||!c.workflowPolicy.practicalProfileEnabled||c.workflowPolicy.budgets.llmCalls!==14)throw Error('Unexpected policy'); console.log(JSON.stringify({configuration_valid:true}));"
        assert json.loads(command(args,input=code))['configuration_valid']
    finally: private_env.unlink()
    state['proposed_override_sha256']=sha(proposed_path)
    (backup/'deployment.json').write_text(json.dumps(state,indent=2)+'\n'); os.chmod(backup/'deployment.json',0o600)
    emit(event='prepared',revision=revision,image_id=state['image_id'],configuration_valid=True,services_unchanged=True)
else:
    assert len(sys.argv)==3
    state=json.loads((backup/'deployment.json').read_text())
    assert state['revision']==revision and sha(override)==state['override_sha256']
    assert inspect('gateway')['Id']==state['gateway_id'] and inspect('research-worker')['Id']==state['worker_id']
    assert str((root/'current').resolve())==state['old_current'] and unfinished()==0
    gateway=inspect('gateway')
    for destination,filenames in [('/var/lib/codex-gateway',['gateway.db','client-events.db']),('/var/lib/codex-gateway-research',['research.db'])]:
        folder=pathlib.Path(mounts(gateway)[destination])
        for filename in filenames:
            target=backup/filename; assert not target.exists()
            with read_db(folder/filename) as db, sqlite3.connect(target) as copy:
                check_db(db); db.backup(copy); check_db(copy)
            os.chmod(target,0o600)
    emit(event='prechange_databases_backed_up',revision=revision)
    command(['docker','stop','--time','45','codex_gateway_r760-research-worker-1'])
    if unfinished()!=0:
        command(['docker','start','codex_gateway_r760-research-worker-1'])
        raise RuntimeError('A task arrived during drain; old Worker restarted, release not activated')
    assert sha(override)==state['override_sha256']
    proposed=backup/'proposed.override.yml'; assert sha(proposed)==state['proposed_override_sha256']
    temp=override.with_suffix('.research-practical.tmp'); assert not temp.exists()
    shutil.copyfile(proposed,temp); os.chmod(temp,stat.S_IMODE(override.stat().st_mode)); os.replace(temp,override)
    command(compose(override)+['up','-d','--no-deps','--no-build','--force-recreate','--wait','--wait-timeout','90','gateway','research-worker'])
    for name in ['gateway','research-worker']:
        value=inspect(name)
        assert value['Image']==state['image_id'] and value['State']['Health']['Status']=='healthy' and value['RestartCount']==0
    assert all(inspect(name)['Id']==identity for name,identity in state['unrelated'].items())
    for name,target in [('previous',state['old_current']),('current',str(release))]:
        temp=root/(name+'.research-practical.tmp'); assert not temp.exists() and not temp.is_symlink()
        temp.symlink_to(target); os.replace(temp,root/name)
    result={'event':'activated','revision':revision,'image_id':state['image_id'],'activated_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'backup':str(backup),'public_smoke_pending':True}
    (backup/'activation.json').write_text(json.dumps(result,indent=2)+'\n'); os.chmod(backup/'activation.json',0o600)
    emit(**result)
