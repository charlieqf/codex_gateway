"""Bounded FIFO scheduling for private, single-request GPU workers.

Never retry a dispatched generation. A timed-out/disconnected job retains its
worker lease until health confirms the GPU worker has finished.
"""
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import logging
import os
import json
import secrets
import time
from uuid import uuid4

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from qwen_eval_api import Generate

LOG = logging.getLogger('qwen_pool')
API_KEY = os.environ.get('QWEN_IMAGE_API_KEY', '')
BACKENDS = ['http://127.0.0.1:8200', 'http://127.0.0.1:8201']


@dataclass
class Worker:
    url: str
    leased: bool = False
    health: dict = field(default_factory=dict)
    completed: int = 0


@dataclass
class Job:
    body: dict
    future: asyncio.Future
    submitted: float
    deadline: float
    abandoned: bool = False
    operation_id: str = field(default_factory=lambda: 'image-'+uuid4().hex)
    scheduler_body: dict | None = None
    task_id: str | None = None
    ticket: dict | None = None


class Pool:
    def __init__(self, client, backends=BACKENDS, *, budget=170, queue_wait=80, poll=0.5):
        self.client = client
        self.workers = [Worker(url) for url in backends]
        self.queue = deque()
        self.budget, self.queue_wait, self.poll = budget, queue_wait, poll
        self.tasks = set()
        self.scheduler = None
        self.broker = None
        if os.environ.get('GPU_SCHEDULER_SOCKET') or os.environ.get('GPU_SCHEDULER_REQUIRED') == '1':
            from star_gpu_scheduler.client import Client
            self.broker = Client.from_env('qwen_pool')

    async def health(self, worker):
        try:
            response = await self.client.get(worker.url+'/healthz', timeout=6)
            response.raise_for_status()
            value = response.json()
            if not isinstance(value, dict) or type(value.get('busy')) is not bool or type(value.get('accepting')) is not bool:
                raise ValueError('Invalid worker health')
            value['accepting'] = value['accepting'] and value.get('status') == 'ready' and not value['busy']
            worker.health = value
        except Exception:
            worker.health = {'status': 'unavailable', 'accepting': False}

    async def start(self):
        await asyncio.gather(*(self.health(w) for w in self.workers))
        self.scheduler = asyncio.create_task(self.schedule())

    async def close(self):
        if self.scheduler:
            self.scheduler.cancel()
            await asyncio.gather(self.scheduler, return_exceptions=True)
        for job in self.queue:
            if self.broker and job.task_id:
                try:
                    await asyncio.to_thread(self.broker.cancel, job.task_id, 'producer_shutdown')
                except Exception:
                    pass
            self.finish(job, 503, {'detail': 'Image service shutting down'})
        # systemd allows in-flight requests to finish before terminating workers.
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    def submit(self, body):
        if not self.broker:
            self.queue = deque(j for j in self.queue if not j.abandoned)
        if len(self.queue) + sum(w.leased for w in self.workers) >= len(self.workers)+2:
            raise HTTPException(429, 'Image queue full', headers={'Retry-After': '30'})
        if not any(w.health.get('status') == 'ready' for w in self.workers):
            raise HTTPException(503, 'No image worker ready')
        now = time.monotonic()
        job = Job(body, asyncio.get_running_loop().create_future(), now, now+self.budget)
        self.queue.append(job)
        return job

    @staticmethod
    def finish(job, status, payload):
        if not job.future.done():
            job.future.set_result((status, payload))

    async def schedule(self):
        if self.broker:
            await self.schedule_shared()
            return
        while True:
            await asyncio.gather(*(self.health(w) for w in self.workers))
            now = time.monotonic()
            while self.queue and (self.queue[0].abandoned or now-self.queue[0].submitted >= self.queue_wait or now >= self.queue[0].deadline):
                job = self.queue.popleft()
                self.finish(job, 503, {'detail': 'Image queue wait exceeded'})
            for worker in self.workers:
                if not self.queue:
                    break
                if worker.leased or not worker.health.get('accepting', False):
                    continue
                job = self.queue.popleft()
                if job.abandoned:
                    continue
                worker.leased = True
                task = asyncio.create_task(self.run(worker, job))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            await asyncio.sleep(self.poll)

    async def schedule_shared(self):
        from star_gpu_scheduler.protocol import PROFILES, TERMINAL, digest
        while True:
            await asyncio.gather(*(self.health(w) for w in self.workers))
            for job in list(self.queue):
                now = time.monotonic()
                expired = now-job.submitted >= self.queue_wait or now >= job.deadline
                try:
                    if job.abandoned or expired:
                        if job.task_id:
                            try:
                                await asyncio.to_thread(self.broker.cancel, job.task_id,
                                    'client_disconnected' if job.abandoned else 'deadline')
                            except Exception:
                                pass  # Unclaimed grants expire after the producer heartbeat stops.
                        self.queue.remove(job)
                        self.finish(job, 503, {'detail': 'Image queue wait exceeded'})
                        continue
                    if job.scheduler_body is None:
                        job.scheduler_body = {'schema_version': 1, 'producer_instance': self.broker.instance,
                            'operation_id': job.operation_id, 'kind': 'image', 'profile': PROFILES['image'],
                            'payload_sha256': digest(job.body),
                            'queue_timeout_ms': max(1, int(min(self.queue_wait-(now-job.submitted), job.deadline-now)*1000)),
                            'request_budget_ms': max(1, int((job.deadline-now)*1000))}
                    if job.task_id is None:
                        value = await asyncio.to_thread(self.broker.rpc, 'POST', '/v1/tasks', job.scheduler_body)
                        job.task_id = value['task_id']
                    await asyncio.to_thread(self.broker.producer_heartbeat, job.task_id)
                    value = await asyncio.to_thread(self.broker.get, job.task_id)
                    if value['state'] in TERMINAL:
                        self.queue.remove(job)
                        self.finish(job, 503, {'detail': 'Image scheduler admission ended'})
                    elif value.get('grant'):
                        index = int(value['grant']['executor'].rsplit('_', 1)[1])
                        worker = self.workers[index]
                        if worker.leased:
                            continue
                        job.ticket = value
                        worker.leased = True
                        self.queue.remove(job)
                        task = asyncio.create_task(self.run(worker, job))
                        self.tasks.add(task)
                        task.add_done_callback(self.tasks.discard)
                except Exception:
                    # Preserve an ambiguous registration and its operation ID until cancelled
                    # or expired; never dispatch directly when the broker cannot be reached.
                    if time.monotonic() >= job.deadline:
                        job.abandoned = True
                        self.finish(job, 503, {'detail': 'Image scheduler unavailable'})
            await asyncio.sleep(self.poll)

    async def run(self, worker, job):
        started = time.monotonic()
        uncertain = False
        try:
            if started >= job.deadline:
                self.finish(job, 503, {'detail': 'Image request deadline exceeded'})
                return
            headers = {'Authorization': 'Bearer '+API_KEY}
            if job.ticket:
                headers['X-Scheduler-Ticket'] = json.dumps(job.ticket, separators=(',', ':'))
            response = await self.client.post(worker.url+'/v1/images/generations', json=job.body,
                headers=headers, timeout=max(0.01, job.deadline-started))
            payload = response.json()
            if response.status_code == 200:
                payload['dispatch'] = {'worker': self.workers.index(worker),
                    'queue_seconds': started-job.submitted, 'worker_seconds': time.monotonic()-started}
                worker.completed += 1
            self.finish(job, response.status_code, payload)
        except Exception as exc:
            uncertain = True
            LOG.warning('Worker %s transport failure: %s', self.workers.index(worker), type(exc).__name__)
            self.finish(job, 503, {'detail': 'Image worker unavailable or timed out'})
        finally:
            # Even after a transport timeout the worker may still be generating.
            # An unavailable worker is never offered another job by the scheduler.
            if uncertain:
                while True:
                    await self.health(worker)
                    if worker.health.get('status') == 'ready' and worker.health.get('busy') is False:
                        break
                    await asyncio.sleep(self.poll)
            worker.leased = False
            if self.broker and job.task_id:
                try:
                    await asyncio.to_thread(self.broker.cancel, job.task_id, 'producer_shutdown')
                except Exception:
                    pass

    def snapshot(self):
        return {'status': 'ready' if any(w.health.get('status') == 'ready' for w in self.workers) else 'unavailable',
            'model': 'qwen-image-2.1', 'replicas': len(self.workers), 'queue_capacity': 2,
            'queued': sum(not j.abandoned for j in self.queue), 'active': sum(w.leased for w in self.workers),
            'workers': [{'id': i, 'leased': w.leased, 'completed': w.completed, **w.health}
                for i, w in enumerate(self.workers)]}


@asynccontextmanager
async def lifespan(app):
    if len(API_KEY) < 32:
        raise RuntimeError('QWEN_IMAGE_API_KEY must contain at least 32 characters')
    async with httpx.AsyncClient(trust_env=False) as client:
        app.state.pool = Pool(client)
        await app.state.pool.start()
        try:
            yield
        finally:
            await app.state.pool.close()


app = FastAPI(lifespan=lifespan)


@app.get('/healthz')
async def health(request: Request):
    return request.app.state.pool.snapshot()


@app.get('/v1/models')
async def models():
    return {'object': 'list', 'data': [{'id': 'qwen-image-2.1', 'object': 'model', 'owned_by': 'Qwen'}]}


@app.post('/v1/images/generations')
async def generate(body: Generate, request: Request, authorization: str | None = Header(default=None)):
    if not API_KEY or not secrets.compare_digest((authorization or '').encode(), ('Bearer '+API_KEY).encode()):
        raise HTTPException(401, 'Invalid upstream credential')
    if body.model not in ('qwen-image-2.1', 'Qwen/Qwen-Image-2.1') or body.response_format != 'b64_json':
        raise HTTPException(400, 'Invalid model or response format')
    try:
        width, height = map(int, body.size.split('x'))
        assert min(width, height) >= 256 and width % 32 == height % 32 == 0 and width*height <= 2048**2
    except (ValueError, AssertionError):
        raise HTTPException(400, 'Invalid size')
    job = request.app.state.pool.submit(body.model_dump())
    try:
        while not job.future.done():
            await asyncio.wait({job.future}, timeout=0.25)
            if await request.is_disconnected():
                raise HTTPException(499, 'Client disconnected')
            if time.monotonic() >= job.deadline:
                raise HTTPException(503, 'Image request deadline exceeded')
        status, payload = job.future.result()
        return JSONResponse(payload, status_code=status)
    finally:
        job.abandoned = True
