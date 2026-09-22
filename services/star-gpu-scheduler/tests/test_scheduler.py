"""Real SQLite/state-machine tests; synthetic hardware, no model imports."""
import copy
import os
from pathlib import Path
import tempfile
import time
import unittest

from star_gpu_scheduler.core import Scheduler
from star_gpu_scheduler.protocol import GPU0, GPU1, GPUS, PROFILES, Rejected, digest


def peer(role, pid=100):
    return {'pid': pid, 'boot_id': 'test-boot', 'start_ticks': pid, 'unit': role, 'invocation_id': str(pid)}


class Hardware:
    units = {'indextts': 'tts'}

    def __init__(self):
        self.locked = set()
        self.dead = set()
        self.receipts = set()
        self.snapshot = {'ok': True, 'gpus': {g: {'free_mib': 40000, 'temperature': 40, 'processes': []} for g in GPUS},
            'memory_available_mib': 200000, 'cgroups': {f'qwen_worker_{i}': {'current_mib': 40000, 'ready': True} for i in (0, 1)}}

    def observe(self):
        return {**copy.deepcopy(self.snapshot), 'mono': time.monotonic()}

    def lock_free(self, gpu):
        return gpu not in self.locked

    def owns_lock(self, gpu, pid):
        return gpu in self.locked

    def alive(self, value):
        return value['pid'] not in self.dead

    def receipt(self, execution, task):
        return task['id'] in self.receipts

    def executor_allowed(self, role, value):
        return value['unit'] == role


class Scheduling(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'scheduler.sqlite'
        self.hw = Hardware()
        self.now = 1000.
        self.s = Scheduler(self.path, self.hw, clock=lambda: self.now)
        self.s.tick()
        self.s.admin('resume', {'scope': 'all', 'gpu_uuid': None, 'reason_code': 'verification'})

    def tearDown(self):
        self.s.close()
        self.temp.cleanup()

    def submit(self, kind='image', operation=None, role=None):
        role = role or ('qwen_pool' if kind == 'image' else 'qwen_worker_1' if kind == 'image_init' else 'radar_service')
        body = {'schema_version': 1, 'producer_instance': role+'-instance',
            'operation_id': operation or f'op-{len(self.s.tasks())}', 'kind': kind,
            'profile': PROFILES[kind], 'payload_sha256': digest({'fake': True})}
        if kind in ('image', 'image_init'):
            body.update(queue_timeout_ms=80000, request_budget_ms=170000)
        else:
            body['expires_at'] = 5000
        return self.s.register(role, body, peer(role)), body

    def claim(self, result):
        task = self.s.task(result['task_id'])
        grant = self.s.get(task['id'], task['role'])['grant']
        executor = peer(grant['executor'], 200+int(grant['executor'].endswith('1')))
        if grant['gpu_uuid']:
            self.hw.locked.add(grant['gpu_uuid'])
        fields = {'generation': grant['generation'], 'grant_token': grant['token']}
        self.s.command(task['id'], 'claim', grant['executor'], {**fields, 'payload_sha256': task['payload_sha256'],
            'unit': executor['unit'], 'invocation_id': executor['invocation_id']}, executor)
        return task['id'], fields, executor

    def test_two_images_use_distinct_gpus_and_fifth_is_rejected(self):
        for _ in range(4): self.submit()
        with self.assertRaises(Rejected) as error: self.submit()
        self.assertEqual(error.exception.status, 429)
        self.s.tick()
        tasks = self.s.tasks()
        self.assertEqual([t['gpu'] for t in tasks[:2]], [GPU0, GPU1])
        self.assertEqual([t['state'] for t in tasks], ['granted', 'granted', 'queued', 'queued'])

    def test_ct_takes_gpu1_image_takes_gpu0(self):
        self.submit('image'); self.submit('ct_infer'); self.submit('image')
        self.s.tick()
        self.assertEqual([(t['kind'], t['gpu'], t['state']) for t in self.s.tasks()],
            [('image', GPU0, 'granted'), ('ct_infer', GPU1, 'granted'), ('image', None, 'queued')])

    def test_ct_does_not_preempt_running_image(self):
        self.submit(); image, _ = self.submit()
        self.s.tick()
        self.claim(image[1])
        self.submit('ct_infer')
        self.s.tick()
        self.assertEqual(self.s.tasks()[-1]['state'], 'queued')

    def test_image_budget_and_idempotency_are_not_refreshed(self):
        (code, value), body = self.submit()
        self.now += 30
        code, again = self.s.register('qwen_pool', body, peer('qwen_pool'))
        self.assertEqual(code, 200)
        self.assertEqual(value['task_id'], again['task_id'])
        self.assertEqual(self.s.task(value['task_id'])['queue_deadline'], 1080)
        self.now = 1081
        self.s.tick()
        self.assertEqual(self.s.task(value['task_id'])['state'], 'expired')

    def test_changed_payload_same_operation_is_conflict(self):
        _, body = self.submit()
        body['payload_sha256'] = 'b'*64
        with self.assertRaises(Rejected) as error: self.s.register('qwen_pool', body, peer('qwen_pool'))
        self.assertEqual(error.exception.code, 'idempotency_conflict')

    def test_cancel_queued_never_claims(self):
        (_, value), body = self.submit()
        self.s.command(value['task_id'], 'cancel', 'qwen_pool',
            {'producer_instance': body['producer_instance'], 'reason': 'explicit_cancel'}, peer('qwen_pool'))
        self.s.tick()
        self.assertEqual(self.s.task(value['task_id'])['state'], 'cancelled')

    def test_heartbeat_loss_keeps_busy_gpu_reserved(self):
        (_, value), _ = self.submit('ct_infer')
        self.s.tick()
        task, _, _ = self.claim(value)
        self.now += 11
        self.s.tick()
        self.assertEqual(self.s.task(task)['state'], 'recovering')
        self.assertEqual(self.s.db.execute('SELECT task_id FROM slots WHERE gpu=?', (GPU1,)).fetchone()[0], task)

    def test_finish_does_not_release_held_lock(self):
        (_, value), _ = self.submit()
        self.s.tick()
        task, fields, executor = self.claim(value)
        self.s.command(task, 'finish', executor['unit'], {**fields, 'outcome': 'succeeded', 'error_code': None}, executor)
        self.hw.receipts.add(task)
        self.s.tick()
        self.assertEqual(self.s.task(task)['state'], 'releasing')
        self.hw.locked.clear()
        self.s.tick()
        self.assertEqual(self.s.task(task)['state'], 'succeeded')

    def test_restart_cannot_free_a_running_executor(self):
        (_, value), _ = self.submit('ct_infer')
        self.s.tick(); task, _, executor = self.claim(value)
        self.s.close()
        self.s = Scheduler(self.path, self.hw, clock=lambda: self.now)
        self.now += 20
        self.s.tick()
        self.assertEqual(self.s.task(task)['state'], 'recovering')
        self.hw.dead.add(executor['pid']); self.hw.locked.clear()
        self.s.tick()
        self.assertEqual(self.s.task(task)['state'], 'failed')

    def test_stale_grant_is_rejected(self):
        (_, value), _ = self.submit()
        self.s.tick()
        task, fields, executor = self.claim(value)
        with self.assertRaises(Rejected):
            self.s.command(task, 'heartbeat', executor['unit'], {**fields, 'generation': 99, 'phase': 'inference'}, executor)

    def test_host_memory_and_ct_reservation_block_images(self):
        self.hw.snapshot['memory_available_mib'] = 45000
        self.hw.snapshot['gpus'][GPU1]['free_mib'] = 20000
        self.submit('ct_infer'); self.submit()
        self.s.tick()
        self.assertTrue(all(t['state'] == 'queued' for t in self.s.tasks()))
        self.assertEqual(self.s.tasks()[1]['wait_reason'], 'waiting_memory')

    def test_hot_gpu_is_not_granted(self):
        self.hw.snapshot['gpus'][GPU0]['temperature'] = 81
        self.hw.snapshot['gpus'][GPU1]['temperature'] = 81
        self.submit(); self.s.tick()
        self.assertEqual(self.s.tasks()[0]['state'], 'queued')

    def test_invalid_telemetry_stops_admission(self):
        self.hw.snapshot['ok'] = False
        self.submit(); self.s.tick()
        self.assertFalse(self.s.ready)
        self.assertEqual(self.s.tasks()[0]['state'], 'queued')

    def test_cpu_preprocess_uses_no_gpu_but_blocks_another_ct_child(self):
        self.submit('ct_preprocess'); self.submit('ct_preprocess')
        self.s.tick()
        self.assertEqual([(t['state'], t['gpu']) for t in self.s.tasks()], [('granted', None), ('queued', None)])

    def test_initialization_is_behind_ct_on_gpu1(self):
        self.submit('image_init'); self.submit('ct_infer')
        self.s.tick()
        self.assertEqual([t['state'] for t in self.s.tasks()], ['queued', 'granted'])

    def test_unknown_process_blocks_gpu(self):
        for gpu in GPUS:
            self.hw.snapshot['gpus'][gpu]['processes'] = [peer('unknown')]
        self.submit(); self.s.tick()
        self.assertEqual(self.s.tasks()[0]['wait_reason'], 'unmanaged_gpu_process')

    def test_clock_rollback_drains(self):
        self.now -= 5; self.s.tick()
        self.assertFalse(self.s.ready)
        self.assertEqual(self.s.status()['drain'], 'all')

    def test_restarted_unclaimed_grant_changes_generation(self):
        (_,value),body=self.submit()
        self.s.tick()
        old=self.s.get(value['task_id'],'qwen_pool')['grant']
        self.s.close()
        self.s=Scheduler(self.path,self.hw,clock=lambda:self.now)
        self.s.tick()
        new=self.s.get(value['task_id'],'qwen_pool')['grant']
        self.assertGreater(new['generation'],old['generation'])
        self.assertNotEqual(new['token'],old['token'])

    def test_concurrent_submit_never_exceeds_capacity(self):
        from concurrent.futures import ThreadPoolExecutor
        def submit(index):
            try: return self.submit(operation='parallel-'+str(index))[0][0]
            except Rejected as exc: return exc.status
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(submit,range(32)))
        self.assertEqual(results.count(201),4)
        self.assertEqual(results.count(429),28)
        self.s.tick()
        self.assertEqual(self.s.status()['counts']['granted'],2)

    def test_preprocessing_has_memory_priority_over_new_images(self):
        self.hw.snapshot['memory_available_mib']=50000
        self.submit();self.submit('ct_preprocess');self.s.tick()
        self.assertEqual([t['state'] for t in self.s.tasks()],['queued','granted'])

    def test_sqlite_write_failure_closes_admission(self):
        self.s.db.execute('PRAGMA query_only=ON')
        with self.assertRaises(Rejected) as error: self.submit()
        self.assertEqual(error.exception.code,'storage_unavailable')
        self.assertFalse(self.s.status()['ready'])

    def test_record_has_no_prompt_patient_data_or_raw_token(self):
        self.submit();self.s.tick()
        record=self.s.db.execute('SELECT payload FROM tasks').fetchone()[0]
        grant=self.s.get(self.s.tasks()[0]['id'],'qwen_pool')['grant']
        self.assertNotIn(grant['token'],record)
        self.assertNotIn('prompt',record)

    def test_protocol_rejects_unknown_fields_nonfinite_deadline_and_wrong_role(self):
        import copy
        (_,value),body=self.submit()
        bad=copy.deepcopy(body);bad['prompt']='never store this'
        with self.assertRaises(Rejected): self.s.register('qwen_pool',bad,peer('qwen_pool'))
        with self.assertRaises(Rejected): self.s.register('radar_service',body,peer('radar_service'))
        _,ct=self.submit('ct_infer');ct['expires_at']=float('nan')
        with self.assertRaises(Rejected): self.s.register('radar_service',ct,peer('radar_service'))

    def test_loading_worker_does_not_receive_image_ticket(self):
        for cgroup in self.hw.snapshot['cgroups'].values(): cgroup['ready']=False
        self.submit();self.s.tick()
        self.assertEqual(self.s.tasks()[0]['state'],'queued')


if __name__ == '__main__':
    unittest.main()
