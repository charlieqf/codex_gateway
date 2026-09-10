"""Remote isolated probe launcher. Defaults to offline; explicit live mode has a two-search cap."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import re
import tarfile

kind, label = sys.argv[1:] if len(sys.argv) == 3 else ('offline', '20260910-v1')
assert kind in ('offline', 'offline-evidence', 'live') and re.fullmatch(r'[a-z0-9-]{1,60}', label)
root = Path(f'/tmp/doctor-research-agent-{kind}-{label}')
archive = root.with_suffix('.tgz')
root.mkdir(mode=0o700, exist_ok=False)
with tarfile.open(archive) as bundle:
    assert all((root / member.name).resolve().is_relative_to(root.resolve()) for member in bundle.getmembers())
    bundle.extractall(root, filter='data')
worker = 'codex_gateway_r760-research-worker-1'
config = json.loads(subprocess.check_output(['docker', 'inspect', worker]))[0]
uid = int(subprocess.check_output(['docker', 'exec', worker, 'id', '-u']))
gid = int(subprocess.check_output(['docker', 'exec', worker, 'id', '-g']))
subprocess.run(['chown', '-R', f'{uid}:{gid}', str(root)], check=True)
manifest = {'archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'worker_image': config['Image'],
            'maximum_serpapi_requests': 2 if kind == 'live' else 0,
            'model_call_batch_limit': 16 if kind == 'offline-evidence' else 12 if kind == 'offline' else 7,
            'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file()}}
private = root.with_suffix('.env')
fd = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'w') as stream:
        for entry in config['Config']['Env']:
            assert '\n' not in entry and '\r' not in entry
            stream.write(entry + '\n')
    command = ['docker', 'run', '--rm', '--name', root.name, '--read-only',
               '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--network', next(iter(config['NetworkSettings']['Networks'])),
               '--volumes-from', worker + ':ro', '--mount', f'type=bind,src={root},dst={root}',
               '--user', f'{uid}:{gid}', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
               '--workdir', str(root), '--entrypoint', 'node', '--env-file', str(private),
               config['Image'], str(root / 'probe.mjs')]
    print(json.dumps({'event': f'{kind}_probe_frozen', **manifest}), flush=True)
    with (root / 'probe.jsonl').open('w') as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
        for line in process.stdout:
            log.write(line)
            log.flush()
            print(line.strip(), flush=True)
        process.wait()
    manifest['exit_code'] = process.returncode
    manifest['code_unchanged'] = all(hashlib.sha256((root / name).read_bytes()).hexdigest() == digest for name, digest in manifest['files'].items())
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2))
finally:
    private.unlink(missing_ok=True)
