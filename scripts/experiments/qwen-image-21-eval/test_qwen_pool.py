"""Exercise actual asynchronous scheduling with controlled HTTP backends."""
import asyncio
import os
os.environ['QWEN_IMAGE_API_KEY'] = 'unit-test-key-with-at-least-32-characters'
import unittest

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from unittest.mock import patch
import qwen_pool as api
import qwen_eval_api as worker_api


class Backends:
    def __init__(self):
        self.release = [asyncio.Event(), asyncio.Event()]
        self.busy = [False, False]
        self.online = [True, True]
        self.calls = []
        self.peak = 0
        self.time_out = False

    async def handle(self, request):
        i = 0 if request.url.port == 8200 else 1
        if request.method == 'GET':
            return httpx.Response(200, json={'status': 'ready' if self.online[i] else 'loading',
                'busy': self.busy[i], 'accepting': self.online[i] and not self.busy[i], 'gpu_id': i})
        assert not self.busy[i], 'Overlapping generation on one GPU'
        self.calls.append(i)
        self.busy[i] = True
        self.peak = max(self.peak, sum(self.busy))
        if self.time_out:
            raise httpx.ReadTimeout('simulated', request=request)
        await self.release[i].wait()
        self.busy[i] = False
        return httpx.Response(200, json={'data': [{'b64_json': 'test'}]})


class PoolScheduling(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = Backends()
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.backend.handle))
        self.pool = api.Pool(self.client, poll=0.005, queue_wait=1, budget=2)
        await self.pool.start()

    async def asyncTearDown(self):
        self.backend.busy = [False, False]
        for event in self.backend.release:
            event.set()
        await self.pool.close()
        await self.client.aclose()

    async def until(self, condition):
        async with asyncio.timeout(1):
            while not condition():
                await asyncio.sleep(0.005)

    async def test_two_parallel_workers_and_bounded_waiting_queue(self):
        jobs = [self.pool.submit({'prompt': str(i)}) for i in range(4)]
        with self.assertRaises(HTTPException) as error:
            self.pool.submit({'prompt': 'overflow'})
        self.assertEqual(error.exception.status_code, 429)
        await self.until(lambda: len(self.backend.calls) == 2)
        self.assertEqual(self.backend.peak, 2)
        self.assertEqual(self.pool.snapshot()['queued'], 2)
        for event in self.backend.release:
            event.set()
        results = await asyncio.wait_for(asyncio.gather(*(j.future for j in jobs)), 1)
        self.assertEqual([r[0] for r in results], [200]*4)
        self.assertEqual(sorted(self.backend.calls), [0, 0, 1, 1])

    async def test_disconnected_active_job_does_not_free_gpu_early(self):
        jobs = [self.pool.submit({'prompt': str(i)}) for i in range(4)]
        await self.until(lambda: len(self.backend.calls) == 2)
        jobs[0].abandoned = True
        jobs[2].abandoned = True
        await asyncio.sleep(0.03)
        self.assertEqual(len(self.backend.calls), 2)
        self.assertEqual(sum(w.leased for w in self.pool.workers), 2)
        for event in self.backend.release:
            event.set()
        await asyncio.wait_for(jobs[3].future, 1)
        self.assertEqual(len(self.backend.calls), 3)

    async def test_unavailable_worker_and_queue_expiry(self):
        self.backend.online[1] = False
        await self.pool.health(self.pool.workers[1])
        self.pool.queue_wait = 0.04
        first = self.pool.submit({'prompt': 'one'})
        await self.until(lambda: len(self.backend.calls) == 1)
        second = self.pool.submit({'prompt': 'two'})
        status, _ = await asyncio.wait_for(second.future, 1)
        self.assertEqual(status, 503)
        self.assertEqual(self.backend.calls, [0])
        self.backend.release[0].set()
        self.assertEqual((await first.future)[0], 200)

    async def test_transport_timeout_keeps_lease_until_worker_finishes(self):
        self.backend.time_out = True
        self.backend.online[1] = False
        await self.pool.health(self.pool.workers[1])
        first = self.pool.submit({'prompt': 'one'})
        self.assertEqual((await asyncio.wait_for(first.future, 1))[0], 503)
        self.pool.submit({'prompt': 'two'})
        await asyncio.sleep(0.04)
        self.assertTrue(self.pool.workers[0].leased)
        self.assertEqual(self.backend.calls, [0])
        self.backend.time_out = False
        self.backend.busy[0] = False
        self.backend.release[0].set()
        await self.until(lambda: len(self.backend.calls) == 2)


class HttpContract(unittest.TestCase):
    def test_auth_and_invalid_request_do_not_enter_queue(self):
        client = TestClient(api.app)
        self.assertEqual(client.post('/v1/images/generations', json={'prompt': 'x'}).status_code, 401)
        headers = {'Authorization': 'Bearer '+api.API_KEY}
        for extra in ({'size': '99x100'}, {'model': 'other'}, {'response_format': 'url'}):
            self.assertEqual(client.post('/v1/images/generations', json={'prompt': 'x', **extra}, headers=headers).status_code, 400)

    def test_relaxed_thermal_admission_still_excludes_hot_and_low_memory_gpu(self):
        with patch.object(worker_api, 'state', 'ready'), patch.object(worker_api, 'ADMISSION_TEMPERATURE', 80):
            for temperature, memory, expected in [(75, 39000, True), (80, 39000, True), (81, 39000, False), (45, 29000, False)]:
                with patch.object(worker_api, 'gpu_stats', return_value={'temperature_c': temperature, 'memory_free_mib': memory}):
                    self.assertEqual(worker_api.health()['accepting'], expected)

    def test_physical_gpu_monitor_follows_worker_binding(self):
        with patch.object(worker_api, 'GPU_ID', 0), patch.object(worker_api.subprocess, 'check_output', return_value='45, 500, 48000, 0') as query:
            worker_api.gpu_stats()
            self.assertIn('--id=0', query.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
