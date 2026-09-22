"""Real Unix socket, peer credentials and process locks; no CUDA or models."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from star_gpu_scheduler.client import Client, Lease
from star_gpu_scheduler.core import Scheduler
from star_gpu_scheduler.protocol import GPUS, GPU0, GPU1, ROLES, Rejected
from star_gpu_scheduler.runtime import GpuLock, Runtime


if sys.platform == 'linux':
    from star_gpu_scheduler.server import Server


class SyntheticRuntime(Runtime):
    def observe(self):
        return {'ok': True, 'mono': time.monotonic(), 'memory_available_mib': 200000,
            'gpus': {g: {'free_mib': 40000, 'temperature': 40, 'processes': []} for g in GPUS},
            'cgroups': {f'qwen_worker_{i}': {'ready': True, 'current_mib': 40000} for i in (0,1)}}

    def executor_allowed(self, role, value):
        # Test processes intentionally run outside production systemd units.
        return role in ROLES and value['pid'] > 0


@unittest.skipUnless(sys.platform == 'linux', 'Linux process locks and SO_PEERCRED required')
class LinuxIPC(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gpu-mock-')
        self.root = Path(self.temp.name)
        self.runtime = SyntheticRuntime(self.root, {})
        self.scheduler = Scheduler(self.root/'db.sqlite', self.runtime)
        self.keys = {role: ('offline-only-'+role+'-'*40) for role in ROLES}
        self.server = Server(self.root/'scheduler.sock', self.scheduler, self.keys)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.scheduler.tick()
        self.operator = self.client('operator')
        self.operator.rpc('POST', '/v1/admin/resume', {'scope': 'all', 'gpu_uuid': None, 'reason_code': 'verification'})

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.scheduler.close(); self.temp.cleanup()

    def client(self, role):
        return Client(self.root/'scheduler.sock', self.keys[role])

    def test_real_socket_lease_and_verified_release(self):
        producer = self.client('qwen_pool')
        payload = {'synthetic': 'no inference'}
        task = producer.register('image', 'ipc-image', payload)
        self.scheduler.tick()
        ticket = producer.get(task['task_id'])
        executor = self.client(ticket['grant']['executor'])
        lease = Lease(executor, ticket, payload).acquire()
        try:
            self.assertFalse(self.runtime.lock_free(ticket['grant']['gpu_uuid']))
            self.assertEqual(producer.get(task['task_id'])['state'], 'running')
        finally:
            lease.finish()
        self.scheduler.tick()
        self.assertEqual(producer.get(task['task_id'])['state'], 'succeeded')

    def test_socket_auth_and_owner_scope(self):
        bad = Client(self.root/'scheduler.sock', 'wrong')
        with self.assertRaises(Rejected) as error: bad.rpc('GET', '/v1/status')
        self.assertEqual(error.exception.status, 401)
        producer = self.client('qwen_pool')
        task = producer.register('image', 'scope-image', {})
        with self.assertRaises(Rejected) as error: self.client('radar_service').get(task['task_id'])
        self.assertEqual(error.exception.status, 404)

    def test_worker_cannot_claim_without_physical_lock(self):
        producer = self.client('qwen_pool')
        task = producer.register('image', 'no-lock', {})
        self.scheduler.tick()
        value = producer.get(task['task_id'])
        from star_gpu_scheduler.protocol import digest
        from star_gpu_scheduler.runtime import identity
        who = identity(os.getpid())
        grant = value['grant']
        with self.assertRaises(Rejected) as error:
            self.client(grant['executor']).command(task['task_id'], 'claim',
                {'generation': grant['generation'], 'grant_token': grant['token'], 'payload_sha256': digest({}),
                 'unit': who['unit'], 'invocation_id': who['invocation_id']})
        self.assertEqual(error.exception.code, 'lock_not_held')

    def test_drain_one_gpu_and_resume_preserves_other_drain(self):
        self.operator.rpc('POST', '/v1/admin/drain', {'scope': 'all', 'gpu_uuid': None, 'reason_code': 'maintenance'})
        self.operator.rpc('POST', '/v1/admin/resume', {'scope': 'gpu', 'gpu_uuid': GPU0, 'reason_code': 'maintenance'})
        self.assertEqual(self.scheduler.status()['drain'], GPU1)

    def test_lock_owned_by_child_survives_scheduler_close(self):
        child = subprocess.Popen([sys.executable, __file__, '--lock-child', str(self.root), GPU1],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'LOCKED')
            self.assertFalse(self.runtime.lock_free(GPU1))
            self.scheduler.close()
            self.scheduler = Scheduler(self.root/'db.sqlite', self.runtime)
            self.server.scheduler = self.scheduler
            self.assertFalse(self.runtime.lock_free(GPU1))
        finally:
            child.communicate('\n', timeout=5)
        self.assertTrue(self.runtime.lock_free(GPU1))

    def test_symlink_lock_path_rejected(self):
        path = self.root/('gpu-'+GPU1+'.lock')
        target = self.root/'other'
        target.write_text('do not touch')
        path.symlink_to(target)
        with self.assertRaises(OSError): GpuLock(self.root, GPU1).acquire()
        self.assertEqual(target.read_text(), 'do not touch')

    def test_foreign_process_lock_does_not_authorize_claim(self):
        producer = self.client('qwen_pool')
        task = producer.register('image', 'foreign-lock', {})
        self.scheduler.tick()
        ticket = producer.get(task['task_id'])
        child = subprocess.Popen([sys.executable, __file__, '--lock-child', str(self.root), ticket['grant']['gpu_uuid']],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'LOCKED')
            self.assertTrue(self.runtime.owns_lock(ticket['grant']['gpu_uuid'], child.pid))
            self.assertFalse(self.runtime.owns_lock(ticket['grant']['gpu_uuid'], os.getpid()))
        finally:
            child.communicate('\n', timeout=5)

    def test_lost_claim_response_recovers_without_executing_model(self):
        from unittest.mock import patch
        producer = self.client('qwen_pool')
        task = producer.register('image', 'lost-claim', {})
        self.scheduler.tick()
        ticket = producer.get(task['task_id'])
        executor = self.client(ticket['grant']['executor'])
        command = executor.command
        def lost(*args):
            value = command(*args)
            if args[1] == 'claim':
                raise Rejected('scheduler_unavailable', 503)
            return value
        with patch.object(executor, 'command', side_effect=lost):
            with self.assertRaises(Rejected): Lease(executor, ticket, {}).acquire()
        self.scheduler.tick()
        self.assertEqual(producer.get(task['task_id'])['state'], 'failed')
        self.assertTrue(self.runtime.lock_free(ticket['grant']['gpu_uuid']))

    def test_lost_finish_and_release_rpc_recovers_from_receipt(self):
        from unittest.mock import patch
        producer = self.client('qwen_pool')
        task = producer.register('image', 'lost-release', {})
        self.scheduler.tick()
        ticket = producer.get(task['task_id'])
        executor = self.client(ticket['grant']['executor'])
        lease = Lease(executor, ticket, {}).acquire()
        with patch.object(executor, 'command', side_effect=Rejected('scheduler_unavailable',503)):
            lease.finish()
        self.scheduler.tick()
        self.assertEqual(producer.get(task['task_id'])['state'], 'failed')
        self.assertTrue(self.runtime.lock_free(ticket['grant']['gpu_uuid']))

    def test_cleanup_failure_retains_lock_and_invokes_hard_stop(self):
        from unittest.mock import Mock
        producer = self.client('qwen_pool')
        task = producer.register('image', 'bad-cleanup', {})
        self.scheduler.tick()
        ticket = producer.get(task['task_id'])
        stop = Mock()
        lease = Lease(self.client(ticket['grant']['executor']), ticket, {}, hard_stop=stop).acquire()
        try:
            lease.finish(cleanup_ok=False)
            stop.assert_called_once()
            self.scheduler.tick()
            self.assertFalse(self.runtime.lock_free(ticket['grant']['gpu_uuid']))
            self.assertEqual(producer.get(task['task_id'])['state'], 'running')
        finally:
            lease.finish('failed','cleanup_failed')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--lock-child':
        with GpuLock(sys.argv[2], sys.argv[3]):
            print('LOCKED', flush=True)
            sys.stdin.readline()
    else:
        unittest.main()
