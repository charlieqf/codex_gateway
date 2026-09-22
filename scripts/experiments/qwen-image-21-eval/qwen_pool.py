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
import secrets
import time

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


class Pool:
    def __init__(self, client, backends=BACKENDS, *, budget=170, queue_wait=80, poll=0.5):
        self.client = client
        self.workers = [Worker(url) for url in backends]
        self.queue = deque()
        self.budget, self.queue_wait, self.poll = budget, queue_wait, poll
        self.tasks = set()
        self.scheduler = None

    async def health(self, worker):
        try:
            response = await self.client.get(worker.url+'/healthz', timeout=6)
            response.raise_for_status()
            worker.health = response.json()
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
            self.finish(job, 503, {'detail': 'Image service shutting down'})
        # systemd allows in-flight requests to finish before terminating workers.
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    def submit(self, body):
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
        while True:
            await asyncio.gather(*(self.health(w) for w in self.workers))
            now = time.monotonic()
            while self.queue and (self.queue[0].abandoned or now-self.queue[0].submitted >= self.queue_wait):
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

    async def run(self, worker, job):
        started = time.monotonic()
        uncertain = False
        try:
            response = await self.client.post(worker.url+'/v1/images/generations', json=job.body,
                headers={'Authorization': 'Bearer '+API_KEY}, timeout=max(0.01, job.deadline-started))
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
                    if worker.health.get('status') != 'ready' or not worker.health.get('busy', True):
                        break
                    await asyncio.sleep(self.poll)
            worker.leased = False

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
