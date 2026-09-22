"""Qwen pool -> real broker/SQLite/flock -> fake executors, never model code."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from star_gpu_scheduler.client import Client, Lease
from star_gpu_scheduler.core import Scheduler
from star_gpu_scheduler.protocol import ROLES
from test_linux_ipc import SyntheticRuntime

ROOT = Path(__file__).resolve().parents[3]
QWEN = ROOT/'scripts/experiments/qwen-image-21-eval'
sys.path.insert(0, str(QWEN))

AVAILABLE = sys.platform == 'linux' and importlib.util.find_spec('httpx') and importlib.util.find_spec('fastapi')
if AVAILABLE:
    os.environ['QWEN_IMAGE_API_KEY'] = 'unit-test-key-with-at-least-32-characters'
    import httpx
    import qwen_pool
    from star_gpu_scheduler.server import Server


@unittest.skipUnless(AVAILABLE, 'Linux with Qwen HTTP dependencies required')
class SharedPool(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='adapter-mock-')
        self.root = Path(self.temp.name)
        self.runtime = SyntheticRuntime(self.root, {})
        self.broker = Scheduler(self.root/'db.sqlite', self.runtime)
        self.keys = {role: 'offline-'+role+'x'*40 for role in ROLES}
        self.server = Server(self.root/'scheduler.sock', self.broker, self.keys)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.broker.tick()
        self.broker.admin('resume', {'scope':'all','gpu_uuid':None,'reason_code':'verification'})
        self.done = False
        async def tick():
            while not self.done:
                await asyncio.to_thread(self.broker.tick)
                await asyncio.sleep(.01)
        self.ticker = asyncio.create_task(tick())
        self.busy = [False, False]
        self.release = [asyncio.Event(), asyncio.Event()]
        self.calls = []
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        self.pool = qwen_pool.Pool(self.client, poll=.01, budget=2, queue_wait=1)
        self.pool.broker = self.role('qwen_pool')
        await self.pool.start()

    def role(self, role):
        return Client(self.root/'scheduler.sock', self.keys[role])

    async def asyncTearDown(self):
        for event in self.release: event.set()
        await asyncio.wait_for(self.pool.close(),5)
        await self.client.aclose()
        self.done = True
        await self.ticker
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join()
        self.broker.close()
        self.temp.cleanup()

    async def handle(self, request):
        index = int(request.url.port)-8200
        if request.method == 'GET':
            return httpx.Response(200, json={'status':'ready','busy':self.busy[index],'accepting':not self.busy[index]})
        self.assertFalse(self.busy[index])
        payload = json.loads(request.content)
        ticket = json.loads(request.headers['X-Scheduler-Ticket'])
        lease = await asyncio.to_thread(Lease(self.role('qwen_worker_'+str(index)),ticket,payload).acquire)
        self.busy[index] = True
        self.calls.append(index)
        try:
            await self.release[index].wait()
            return httpx.Response(200,json={'data':[{'b64_json':'synthetic-not-an-image'}]})
        finally:
            try:
                await asyncio.to_thread(lease.finish)
            finally:
                self.busy[index] = False

    async def until(self, check):
        async def wait():
            while not check(): await asyncio.sleep(.01)
        await asyncio.wait_for(wait(), 3)

    async def test_four_images_two_gpus_no_overlapping_executor(self):
        jobs = [self.pool.submit({'prompt':'synthetic-'+str(i)}) for i in range(4)]
        await self.until(lambda: len(self.calls)==2)
        self.assertEqual(sorted(self.calls),[0,1])
        self.assertEqual(self.broker.status()['counts']['running'],2)
        for event in self.release: event.set()
        results = await asyncio.wait_for(asyncio.gather(*(j.future for j in jobs)),3)
        self.assertEqual([r[0] for r in results],[200]*4)
        await self.until(lambda: self.broker.status()['counts']['running']==0)

    async def test_ct_priority_uses_gpu1_and_unblocks_only_after_child_exit(self):
        ct = self.role('radar_service')
        task = await asyncio.to_thread(ct.register,'ct_infer','mock-ct',{},expires_at=__import__('time').time()+120)
        ticket = await asyncio.to_thread(ct.wait,task['task_id'])
        child_code = '''import json,sys
from star_gpu_scheduler.client import Client,Lease
c=Client(sys.argv[1],sys.argv[2]); t=json.loads(sys.argv[3])
l=Lease(c,t,{},process_exit=True).acquire()
print('RUNNING',flush=True); sys.stdin.readline(); l.finish()
'''
        child = subprocess.Popen([sys.executable,'-c',child_code,str(self.root/'scheduler.sock'),self.keys['radar_runner'],json.dumps(ticket)],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(await asyncio.to_thread(child.stdout.readline),'RUNNING\n')
            jobs=[self.pool.submit({'prompt':'synthetic-'+str(i)}) for i in range(2)]
            await self.until(lambda: len(self.calls)==1)
            await asyncio.sleep(.05)
            self.assertEqual(self.calls,[0])
            await asyncio.to_thread(child.communicate,'\n',timeout=5)
            await self.until(lambda: len(self.calls)==2)
            self.assertEqual(self.calls,[0,1])
            for event in self.release: event.set()
            self.assertEqual([r[0] for r in await asyncio.gather(*(j.future for j in jobs))],[200,200])
        finally:
            if child.poll() is None: await asyncio.to_thread(child.communicate,'\n',timeout=5)

    async def test_broker_outage_never_dispatches_and_deadline_is_bounded(self):
        from unittest.mock import patch
        from star_gpu_scheduler.protocol import Rejected
        self.pool.queue_wait=.05
        with patch.object(self.pool.broker,'rpc',side_effect=Rejected('scheduler_unavailable',503)):
            job=self.pool.submit({'prompt':'offline'})
            self.assertEqual((await asyncio.wait_for(job.future,1))[0],503)
        self.assertEqual(self.calls,[])

    async def test_cancel_queued_image_never_runs_after_ct(self):
        self.broker.admin('drain',{'scope':'all','gpu_uuid':None,'reason_code':'verification'})
        job=self.pool.submit({'prompt':'cancelled'})
        await self.until(lambda: job.task_id is not None)
        job.abandoned=True
        await asyncio.wait_for(job.future,1)
        self.broker.admin('resume',{'scope':'all','gpu_uuid':None,'reason_code':'verification'})
        await asyncio.sleep(.05)
        self.assertEqual(self.calls,[])


if __name__ == '__main__': unittest.main()
