"""Linux-only resource observations and process-owned advisory locks."""
import json
import os
from pathlib import Path
import stat
import subprocess
import time

from .protocol import GPUS, require


class GpuLock:
    def __init__(self, directory, gpu):
        require(gpu in GPUS)
        self.path = Path(directory)/('gpu-'+gpu+'.lock')
        self.fd = None

    def acquire(self):
        import fcntl
        # Never unlink a live lock. Every process must open the same inode.
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            value = os.fstat(self.fd)
            require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid(), 'unsafe_lock')
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *args):
        self.close()


def identity(pid):
    root = Path('/proc')/str(pid)
    raw = (root/'stat').read_text()
    fields = raw[raw.rfind(')')+2:].split()
    units = [part for part in (root/'cgroup').read_text().split('/') if '.service' in part]
    unit = units[-1].strip() if units else ''
    env = dict(item.split(b'=', 1) for item in (root/'environ').read_bytes().split(b'\0') if b'=' in item)
    return {'pid': pid, 'start_ticks': int(fields[19]),
        'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'unit': unit, 'invocation_id': env.get(b'INVOCATION_ID', b'').decode()}


def same_process(left, right):
    return all(left.get(k) == right.get(k) for k in ('pid', 'start_ticks', 'boot_id', 'unit', 'invocation_id'))


class Runtime:
    def __init__(self, directory, units):
        self.directory, self.units = Path(directory), units
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not self.directory.is_symlink() and self.directory.stat().st_uid == os.getuid(), 'unsafe_directory')
        os.chmod(self.directory, 0o700)
        self.cache = None

    def lock_free(self, gpu):
        try:
            with GpuLock(self.directory, gpu):
                return True
        except (OSError, ValueError):
            return False

    def owns_lock(self, gpu, pid):
        # A busy inode alone does not prove that the caller owns it.
        try:
            info = (self.directory/('gpu-'+gpu+'.lock')).stat()
            for line in Path('/proc/locks').read_text().splitlines():
                fields = line.split()
                if len(fields) < 8 or fields[1:4] != ['FLOCK', 'ADVISORY', 'WRITE']:
                    continue
                major, minor, inode = fields[5].split(':')
                if int(fields[4]) == pid and (int(major, 16), int(minor, 16), int(inode)) == (
                        os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
                    return True
        except (OSError, ValueError):
            pass
        return False

    def alive(self, execution):
        try:
            return same_process(execution, identity(execution['pid']))
        except FileNotFoundError:
            return False
        except (OSError, ValueError):
            return None

    def observe(self):
        # Bound the observation to one second; callers reject snapshots older than two.
        if self.cache and time.monotonic()-self.cache['mono'] < 1:
            return self.cache
        result = {'mono': time.monotonic(), 'ok': False, 'gpus': {}, 'memory_available_mib': 0, 'cgroups': {}}
        try:
            raw = subprocess.check_output(['nvidia-smi', '--query-gpu=uuid,memory.free,temperature.gpu',
                '--format=csv,noheader,nounits'], text=True, timeout=1)
            for line in raw.splitlines():
                uuid, free, temp = [s.strip() for s in line.split(',')]
                if uuid in GPUS:
                    result['gpus'][uuid] = {'free_mib': int(free), 'temperature': int(temp), 'processes': []}
            processes = subprocess.check_output(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid',
                '--format=csv,noheader,nounits'], text=True, timeout=1)
            for line in processes.splitlines():
                uuid, pid = [s.strip() for s in line.split(',')]
                if uuid in result['gpus']:
                    result['gpus'][uuid]['processes'].append(identity(int(pid)))
            mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
            result['memory_available_mib'] = int(mem['MemAvailable'].split()[0])//1024
            for role, unit in self.units.items():
                if role not in ('qwen_worker_0', 'qwen_worker_1'):
                    continue
                # No shell, no environment/config output.
                data = subprocess.check_output(['systemctl', '--user', 'show', unit,
                    '-p', 'MainPID', '-p', 'MemoryCurrent'], text=True, timeout=1)
                props = dict(line.split('=', 1) for line in data.splitlines() if '=' in line)
                pid = int(props['MainPID'])
                result['cgroups'][role] = {'current_mib': int(props['MemoryCurrent'])//2**20 if pid else 0,
                    'identity': identity(pid) if pid else None, 'ready': False}
                try:
                    ready = json.loads((self.directory/('ready-'+str(pid)+'.json')).read_text())
                    result['cgroups'][role]['ready'] = ready['ready'] is True and same_process(ready['identity'], result['cgroups'][role]['identity'])
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            result['ok'] = all(g in result['gpus'] for g in GPUS)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
        result['ok'] = result['ok'] and time.monotonic()-result['mono'] <= 2
        self.cache = result
        return result

    def executor_allowed(self, role, peer):
        expected = self.units.get(role)
        if role == 'radar_runner':
            return peer['unit'].startswith('radar-task-') and peer['unit'].endswith('.service')
        return bool(expected) and peer['unit'] == expected

    def receipt(self, execution, task):
        # Qwen publishes a content-free, atomic per-process receipt after CUDA cleanup.
        name = self.directory/('receipt-'+str(execution['pid'])+'-'+task['id']+'-'+str(task['generation'])+'.json')
        try:
            value = json.loads(name.read_text())
            return same_process(execution, value['identity']) and value['task_id'] == task['id'] and value['generation'] == task['generation'] and value['released'] is True
        except (OSError, ValueError, KeyError, TypeError):
            return False
