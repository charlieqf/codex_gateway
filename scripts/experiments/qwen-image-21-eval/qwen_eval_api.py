"""Authenticated private Qwen-Image-2.1 endpoint for Gateway and research evaluation."""
from __future__ import annotations
import asyncio
import base64
from contextlib import asynccontextmanager
import io
import json
import logging
import os
import secrets
from pathlib import Path
import subprocess
import threading
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

ROOT = Path('/data/apps/qwen-image-21-eval')
LOG = logging.getLogger('qwen_eval')
pipeline = None
state = 'loading'
load_error = None
lock = threading.Lock()
api_key = os.environ.get('QWEN_IMAGE_API_KEY', '')
GPU_ID = int(os.environ.get('QWEN_GPU_ID', '1'))
ADMISSION_TEMPERATURE = int(os.environ.get('QWEN_ADMISSION_TEMPERATURE', '60'))
STOP_TEMPERATURE = int(os.environ.get('QWEN_STOP_TEMPERATURE', '85'))
assert GPU_ID in (0, 1)
assert 40 <= ADMISSION_TEMPERATURE <= 80
assert ADMISSION_TEMPERATURE < STOP_TEMPERATURE <= 88

def gpu_stats():
    raw = subprocess.check_output(['nvidia-smi',f'--id={GPU_ID}','--query-gpu=temperature.gpu,memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],text=True,timeout=5)
    return dict(zip(['temperature_c','memory_used_mib','memory_free_mib','utilization_percent'],[int(x.strip()) for x in raw.strip().split(',')]))

def load():
    global pipeline, state, load_error
    try:
        import torch
        from diffusers import QwenImage21Pipeline
        assert os.environ.get('CUDA_VISIBLE_DEVICES') == str(GPU_ID), 'GPU binding mismatch'
        assert torch.cuda.device_count() == 1, 'Use only the designated GPU'
        torch.set_num_threads(8)
        torch.cuda.set_per_process_memory_fraction(0.58)
        pipeline = QwenImage21Pipeline.from_pretrained(str(ROOT/'model'),torch_dtype=torch.bfloat16,local_files_only=True,low_cpu_mem_usage=True)
        pipeline.enable_model_cpu_offload(gpu_id=0)
        pipeline.set_progress_bar_config(disable=True)
        state = 'ready'
        LOG.warning('Qwen-Image-2.1 ready; BF16, model CPU offload, GPU%s, allocator cap 58%%', GPU_ID)
    except Exception as exc:
        state = 'error'
        load_error = f'{type(exc).__name__}: {exc}'
        LOG.exception('Model load failed')

@asynccontextmanager
async def lifespan(app):
    if len(api_key) < 32:
        raise RuntimeError('QWEN_IMAGE_API_KEY must contain at least 32 characters')
    task = asyncio.create_task(asyncio.to_thread(load))
    yield
    await task

app = FastAPI(lifespan=lifespan)

class Generate(BaseModel):
    model: str = 'qwen-image-2.1'
    prompt: str = Field(min_length=1,max_length=10000)
    size: str = '1024x1024'
    seed: int = Field(default_factory=lambda: secrets.randbits(63),ge=0,le=2**63-1)
    n: int = Field(default=1,ge=1,le=1)
    num_inference_steps: int = Field(default=40,ge=1,le=50)
    response_format: str = 'b64_json'
    image_b64: str | None = None

@app.get('/healthz')
def health():
    stats = gpu_stats()
    busy = lock.locked()
    return {'status':state,'model':'qwen-image-2.1','purpose':'research-evaluation','profile':'BF16 / model CPU offload / 40 steps / CFG 1','busy':busy,'error':load_error,'gpu_id':GPU_ID,'admission_temperature_c':ADMISSION_TEMPERATURE,'stop_temperature_c':STOP_TEMPERATURE,'accepting':state=='ready' and not busy and stats['temperature_c']<=ADMISSION_TEMPERATURE and stats['memory_free_mib']>=30000,'gpu':stats}

@app.get('/v1/models')
def models():
    return {'object':'list','data':[{'id':'qwen-image-2.1','object':'model','owned_by':'Qwen'}]}

@app.post('/v1/images/generations')
def generate(request: Generate, authorization: str | None = Header(default=None)):
    if not api_key or not secrets.compare_digest((authorization or '').encode(), ('Bearer '+api_key).encode()):
        raise HTTPException(401, 'Invalid upstream credential')
    import torch
    from PIL import Image, ImageStat
    if state != 'ready':
        raise HTTPException(503, 'Model is not ready')
    if request.model not in ('qwen-image-2.1','Qwen/Qwen-Image-2.1'):
        raise HTTPException(400,'Unknown model')
    if request.response_format != 'b64_json':
        raise HTTPException(400,'Private evaluation supports b64_json only')
    try:
        width,height = [int(x) for x in request.size.split('x')]
        assert min(width,height)>=256 and width%32==0 and height%32==0 and width*height<=2048**2
    except Exception:
        raise HTTPException(400,'Invalid size')
    if not lock.acquire(blocking=False):
        raise HTTPException(429,'Evaluation worker busy')
    samples=[]
    stop=threading.Event()
    hot=threading.Event()
    def monitor():
        while not stop.is_set():
            try:
                sample=gpu_stats()
                samples.append(sample)
                if sample['temperature_c']>=STOP_TEMPERATURE:
                    hot.set()
            except Exception:
                hot.set()
            stop.wait(1)
    def callback(pipe,step,timestep,kwargs):
        if hot.is_set():
            raise RuntimeError('GPU thermal or monitoring safety stop')
        if not torch.isfinite(kwargs['latents']).all().item():
            raise RuntimeError('Non-finite generated latent')
        return kwargs
    watcher=None
    try:
        before=gpu_stats()
        if before['temperature_c']>ADMISSION_TEMPERATURE or before['memory_free_mib']<30000:
            raise HTTPException(503,'GPU not idle/cool enough for controlled evaluation')
        torch.cuda.reset_peak_memory_stats()
        watcher=threading.Thread(target=monitor,daemon=True)
        watcher.start()
        kwargs={}
        if request.image_b64:
            if len(request.image_b64)>16000000:
                raise HTTPException(413,'Reference image too large')
            reference=Image.open(io.BytesIO(base64.b64decode(request.image_b64,validate=True)))
            reference.load()
            if reference.width*reference.height>2048**2:
                raise HTTPException(413,'Reference dimensions too large')
            kwargs['image']=reference
        started=time.perf_counter()
        result=pipeline(prompt=request.prompt,width=width,height=height,output_resolution=1024,num_inference_steps=request.num_inference_steps,true_cfg_scale=1.0,generator=torch.Generator('cuda').manual_seed(request.seed),callback_on_step_end=callback,**kwargs).images[0]
        torch.cuda.synchronize()
        inference=time.perf_counter()-started
        if max(ImageStat.Stat(result.convert('RGB')).stddev)<1:
            raise RuntimeError('Degenerate image rejected')
        output=io.BytesIO()
        result.save(output,format='PNG')
        alpha=result.getchannel('A').getextrema() if result.mode=='RGBA' else None
        return {'created':int(time.time()),'model':request.model,'data':[{'b64_json':base64.b64encode(output.getvalue()).decode(),'mime_type':'image/png','seed':request.seed}],'evaluation':{'gpu_id':GPU_ID,'inference_seconds':inference,'torch_peak_allocated_mib':torch.cuda.max_memory_allocated()/2**20,'torch_peak_reserved_mib':torch.cuda.max_memory_reserved()/2**20,'gpu_peak_used_mib':max([x['memory_used_mib'] for x in samples] or [before['memory_used_mib']]),'gpu_max_temperature_c':max([x['temperature_c'] for x in samples] or [before['temperature_c']]),'steps':request.num_inference_steps,'cfg':1,'mode':result.mode,'alpha_extrema':alpha,'profile':'bf16-model-cpu-offload'}}
    except HTTPException:
        raise
    except Exception as exc:
        LOG.exception('Generation failed')
        if pipeline is not None:
            pipeline.maybe_free_model_hooks()
        torch.cuda.empty_cache()
        raise HTTPException(500,f'{type(exc).__name__}: {exc}')
    finally:
        stop.set()
        if watcher:
            watcher.join(timeout=6)
        torch.cuda.empty_cache()
        lock.release()
