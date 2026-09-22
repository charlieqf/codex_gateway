"""Promote committed Qwen workers/pool on star, retaining a complete unit rollback."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/data/apps/qwen-image-21-eval')
UNITS = Path.home()/'.config/systemd/user'
OLD = ['cloudflared-llada-image.service', 'llada-image-api.service', 'qwen-image-21-eval.service']
NEW = ['qwen-image-worker@0.service', 'qwen-image-worker@1.service', 'qwen-image-pool.service']
FILES = ['qwen-image-worker@.service', 'qwen-image-pool.service']


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, text=True)


def systemctl(*args):
    return run('systemctl', '--user', *args)


def unit_state(name):
    return dict(line.split('=', 1) for line in systemctl('show', name,
        '--property=ActiveState,UnitFileState,MainPID,NRestarts').splitlines())


def point(target):
    temporary = ROOT/('current.dual-'+str(os.getpid()))
    temporary.symlink_to(target)
    temporary.replace(ROOT/'current')


def health(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=10) as r:
        return json.load(r)


def restore(backup):
    state = json.loads((backup/'rollback.json').read_text())
    for name in reversed(NEW):
        subprocess.run(['systemctl', '--user', 'disable', '--now', name], capture_output=True)
    point(Path(state['old_current']))
    for name in FILES:
        if (backup/name).exists():
            shutil.copy2(backup/name, UNITS/name)
        elif (UNITS/name).exists():
            (UNITS/name).unlink()
    systemctl('daemon-reload')
    for name in reversed(OLD):
        old = state['units'][name]
        if old['UnitFileState'] == 'enabled':
            systemctl('enable', name)
        if old['ActiveState'] == 'active':
            systemctl('start', name)
    return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('revision')
    parser.add_argument('expected_current')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    assert run('hostname').strip() == 'star'
    if args.rollback:
        restore(args.rollback)
        print(json.dumps({'rollback': str(args.rollback), 'status': 'restored'}))
        return
    current = (ROOT/'current').resolve()
    assert current.name == args.expected_current
    release = ROOT/'releases'/args.revision
    source = release/'scripts/experiments/qwen-image-21-eval'
    assert source.is_dir() and len(args.revision) == 40
    for port in [8200, 8201]:
        import socket
        with socket.socket() as s:
            assert s.connect_ex(('127.0.0.1', port)) != 0, 'New worker port already occupied'
    assert not health(8191)['busy'], 'Wait for active Qwen generation to finish'
    assert all(int(row.split(',')[-1].strip()) == 0 for row in run('nvidia-smi',
        '--query-gpu=index,utilization.gpu', '--format=csv,noheader,nounits').strip().splitlines()), 'GPU busy'
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = ROOT/'state'/('pre-dual-'+stamp)
    backup.mkdir(mode=0o700)
    state = {'revision': args.revision, 'old_current': str(current), 'backup': str(backup),
        'units': {name: unit_state(name) for name in OLD+NEW}, 'indextts': unit_state('indextts2.service')}
    for name in OLD+FILES:
        if (UNITS/name).is_file():
            shutil.copy2(UNITS/name, backup/name)
            assert hashlib.sha256((UNITS/name).read_bytes()).digest() == hashlib.sha256((backup/name).read_bytes()).digest()
    (backup/'rollback.json').write_text(json.dumps(state, indent=2)+'\n')
    (backup/'gpu-before.txt').write_text(run('nvidia-smi', '-q', '-d', 'TEMPERATURE,POWER'))
    print(json.dumps({'backup': str(backup), 'phase': 'backed-up'}), flush=True)
    try:
        for name in FILES:
            shutil.copy2(source/name, UNITS/name)
        run('systemd-analyze', '--user', 'verify', str(UNITS/FILES[0]), str(UNITS/FILES[1]))
        for i in (0, 1):
            for family in ['triton', 'inductor', 'torch']:
                (ROOT/'cache'/f'{family}-{i}').mkdir(mode=0o700, exist_ok=True)
        # The old environment remains on disk: the Qwen venv inherits its Torch.
        for name in OLD:
            systemctl('disable', '--now', name)
        point(release)
        systemctl('daemon-reload')
        systemctl('enable', '--now', *NEW)
        for attempt in range(180):
            try:
                status = health(8191)
                if len(status.get('workers', [])) == 2 and all(w['status']=='ready' for w in status['workers']):
                    break
            except Exception:
                pass
            if attempt % 6 == 0:
                print(json.dumps({'phase': 'loading', 'seconds': attempt*5}), flush=True)
            time.sleep(5)
        else:
            raise RuntimeError('Two Qwen workers did not become ready')
        assert unit_state('indextts2.service')['MainPID'] == state['indextts']['MainPID']
        assert all(unit_state(n)['ActiveState']=='inactive' and unit_state(n)['UnitFileState']=='disabled' for n in OLD)
        assert all(unit_state(n)['ActiveState']=='active' and unit_state(n)['UnitFileState']=='enabled' for n in NEW)
        state.update(status='ready', health=status, verified_utc=datetime.now(timezone.utc).isoformat())
        (backup/'activation.json').write_text(json.dumps(state, indent=2)+'\n')
        print(json.dumps(state, indent=2), flush=True)
    except BaseException:
        restore(backup)
        raise


if __name__ == '__main__':
    main()
