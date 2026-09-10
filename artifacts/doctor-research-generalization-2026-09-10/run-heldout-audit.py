import hashlib
import json
import os
import pathlib
import subprocess
import tarfile

revision = 'a67d2d3a4415d3aceed360d2a394e6f4933964da'
archive = pathlib.Path('/tmp/doctor-research-generic-frozen-a67d2d3.tgz')
input_path = pathlib.Path('/tmp/doctor-research-heldout-inputs-20260910.json')
archive_sha = '421df7f35d59977aa87aa7e7244a64336157902b0da216f64311a6514454869f'
input_sha = 'f7af16073320e8101da23a6a5e27ae0b87f368058bbcee2ae5af3c03b4301a92'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive_sha
assert hashlib.sha256(input_path.read_bytes()).hexdigest() == input_sha
samples = json.loads(input_path.read_bytes())
assert len(samples) == 8
assert all(set(row) == {'id', 'name', 'institution', 'department'} for row in samples)
cases = [dict(name=row['name'], hospital=row['institution'], department=row['department']) for row in samples]
assert all(isinstance(v, str) and v.strip() and '://' not in v for row in cases for v in row.values())
worker = 'codex_gateway_r760-research-worker-1'
config = json.loads(subprocess.check_output(['docker', 'inspect', worker]))[0]
root = pathlib.Path('/tmp/doctor-research-repair-20260910-heldouta67d2d3')
root.mkdir(mode=0o700, exist_ok=False)
with tarfile.open(archive) as bundle:
    assert all((root / member.name).resolve().is_relative_to(root.resolve()) for member in bundle.getmembers())
    bundle.extractall(root, filter='data')
case_bytes = (json.dumps(cases, ensure_ascii=False, indent=2) + '\n').encode('utf8')
(root / 'scripts/ops/doctor-research-repair-cases.json').write_bytes(case_bytes)
os.symlink('/app/node_modules', root / 'node_modules')
code_hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
               for p in root.rglob('*') if p.is_file() and p.suffix in ('.js', '.mjs')}
manifest = dict(revision=revision, archive_sha256=archive_sha, original_input_sha256=input_sha,
                normalized_input_sha256=hashlib.sha256(case_bytes).hexdigest(),
                worker_base_image=config['Image'], case_count=8, fresh_input=True,
                search_cache_disabled=True, official_profile_urls=[], code_sha256=code_hashes,
                protocol='All eight once in fixed order; no runtime code changes or manual evidence injection.')
(root / 'audit-manifest.json').write_text(json.dumps(manifest, indent=2))
uid = int(subprocess.check_output(['docker', 'exec', worker, 'id', '-u']))
gid = int(subprocess.check_output(['docker', 'exec', worker, 'id', '-g']))
subprocess.run(['chown', '-R', f'{uid}:{gid}', str(root)], check=True)
private = root.with_suffix('.env')
fd = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'w') as stream:
        for entry in config['Config']['Env']:
            assert '\n' not in entry and '\r' not in entry
            stream.write(entry + '\n')
    command = ['docker', 'run', '--rm', '--name', root.name, '--read-only',
               '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--network',
               next(iter(config['NetworkSettings']['Networks'])), '--volumes-from', worker + ':ro',
               '--mount', f'type=bind,src={root},dst={root}', '--user', f'{uid}:{gid}',
               '--cpus', '1', '--memory', '1g', '--pids-limit', '256', '--workdir', '/app',
               '--entrypoint', 'node', '--env-file', str(private),
               '-e', 'RESEARCH_REPAIR_PROBE_ROOT=' + str(root),
               '-e', 'RESEARCH_REPAIR_PROBE_MODE=full',
               '-e', 'RESEARCH_REPAIR_FRESH_INPUT=1',
               '-e', 'RESEARCH_REPAIR_NO_SEARCH_CACHE=1',
               config['Image'], str(root / 'scripts/ops/probe-doctor-research-repair.mjs')]
    print(json.dumps({'event': 'audit_frozen', 'revision': revision, 'archive_sha256': archive_sha,
                      'input_sha256': input_sha, 'count': len(cases)}), flush=True)
    with (root / 'probe.jsonl').open('w') as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
        for line in process.stdout:
            log.write(line)
            log.flush()
            item = json.loads(line)
            if item.get('event') in ('probe_started', 'probe_completed', 'probe_validation_failure'):
                print(json.dumps(item, ensure_ascii=False), flush=True)
        process.wait()
    assert all(hashlib.sha256((root / p).read_bytes()).hexdigest() == expected for p, expected in code_hashes.items())
    manifest['code_unchanged_after_test'] = True
    manifest['probe_exit_code'] = process.returncode
    (root / 'audit-manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'event': 'audit_finished', 'exit_code': process.returncode, 'root': str(root)}), flush=True)
finally:
    private.unlink(missing_ok=True)
