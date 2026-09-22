"""Serial local HTTP evaluation; secrets stay on star and never enter artifacts."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import shlex
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request

from PIL import Image, ImageStat

ROOT=Path('/data/apps/qwen-image-21-eval')

def request_json(url, body=None, key=None, timeout=600):
    headers={'Content-Type':'application/json'}
    if key:
        headers['Authorization']='Bearer '+key
    req=urllib.request.Request(url,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers=headers)
    with urllib.request.urlopen(req,timeout=timeout) as r:
        return r.status,json.load(r)

def key_for_llada():
    entries={}
    for line in Path('/data/apps/llada-image/api.env').read_text().splitlines():
        if line.startswith(('LLADA_API_KEYS=','LLADA_UNLIMITED_API_KEYS=')):
            name,value=line.split('=',1)
            entries[name]=''.join(shlex.split(value))
    values=entries.get('LLADA_UNLIMITED_API_KEYS') or entries['LLADA_API_KEYS']
    return values.split(',')[0].strip()

def sample_gpu(gpu):
    data=subprocess.check_output(['nvidia-smi',f'--id={gpu}','--query-gpu=temperature.gpu,memory.used,utilization.gpu,power.draw','--format=csv,noheader,nounits'],text=True,timeout=5)
    return dict(zip(['temperature_c','memory_used_mib','utilization_percent','power_w'],[float(v.strip()) for v in data.strip().split(',')]))

def run_one(base, model, prompt, seed, path, key, gpu, extra=None):
    for _ in range(90):
        _,health=request_json(base+'/healthz',timeout=10)
        stats=sample_gpu(gpu)
        if health['status'] in ('ok','ready') and not health.get('busy') and not health.get('queue_depth') and stats['temperature_c']<=58 and stats['utilization_percent']<=5:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Service did not become idle/cool within 180 seconds')
    body={'model':model,'prompt':prompt,'size':'1024x1024','n':1,'seed':seed,'response_format':'b64_json'}
    if extra:
        body.update(extra)
    stop=threading.Event()
    samples=[]
    def monitor():
        while not stop.is_set():
            try:
                samples.append({'elapsed_s':time.perf_counter()-started,**sample_gpu(gpu)})
            except Exception:
                pass
            stop.wait(0.7)
    started=time.perf_counter()
    watcher=threading.Thread(target=monitor,daemon=True)
    watcher.start()
    try:
        status,response=request_json(base+'/v1/images/generations',body,key)
        elapsed=time.perf_counter()-started
    finally:
        stop.set()
        watcher.join(timeout=6)
    content=base64.b64decode(response['data'][0]['b64_json'],validate=True)
    image=Image.open(io.BytesIO(content))
    image.load()
    assert image.size==(1024,1024),image.size
    assert image.format=='PNG',image.format
    assert max(ImageStat.Stat(image.convert('RGB')).stddev)>1
    path.write_bytes(content)
    alpha=image.getchannel('A') if image.mode=='RGBA' else None
    return {'http_status':status,'elapsed_seconds':elapsed,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),'file':str(path.relative_to(ROOT/'results')),'width':image.width,'height':image.height,'mode':image.mode,'alpha_extrema':alpha.getextrema() if alpha else None,'alpha_nonopaque_fraction':sum(alpha.histogram()[:255])/(image.width*image.height) if alpha else 0,'peak_gpu_memory_mib':max(s['memory_used_mib'] for s in samples),'max_gpu_temperature_c':max(s['temperature_c'] for s in samples),'peak_gpu_power_w':max(s['power_w'] for s in samples),'samples':samples,'provider_evaluation':response.get('evaluation')}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('provider',choices=['llada','qwen'])
    parser.add_argument('--capabilities',action='store_true')
    args=parser.parse_args()
    provider=args.provider
    plan=json.loads((ROOT/'scripts/evaluation_plan.json').read_text())
    base='http://127.0.0.1:'+('8190' if provider=='llada' else '8191')
    model='llada-image-turbo-fp8' if provider=='llada' else 'qwen-image-2.1'
    gpu=0 if provider=='llada' else 1
    key=key_for_llada() if provider=='llada' else next((line.split('=',1)[1].strip() for line in (ROOT/'api.env').read_text().splitlines() if line.startswith('QWEN_IMAGE_API_KEY=')),None)
    out=ROOT/'results'/provider
    out.mkdir(parents=True,exist_ok=True)
    results_path=ROOT/'results'/f'{provider}-results.jsonl'
    existing=[json.loads(line) for line in results_path.read_text().splitlines()] if results_path.exists() else []
    done={(x['test_id'],x['seed']) for x in existing if x.get('http_status')==200}
    if not (out/'warmup.json').exists():
        result=run_one(base,model,'A red ceramic teapot on a plain white table, studio photography, no text',42,out/'warmup.png',key,gpu)
        (out/'warmup.json').write_text(json.dumps(result,indent=2))
        print('WARMUP',provider,round(result['elapsed_seconds'],2),flush=True)
    cases=plan['cases']
    if args.capabilities:
        if provider!='qwen':
            raise ValueError('Capability checks are Qwen-only and excluded from comparison')
        cases=[{'id':'capability_transparency','prompt':'This is an RGBA image with transparency. A cute red panda mascot holding a blue book, clean educational illustration, isolated subject, no lettering. The image has alpha channel and the background is transparent.'},{'id':'capability_edit','prompt':'Change only the red cup on the left to a yellow cup. Keep exactly three cups, their shapes, the white cup in the center, the blue cup on the right, the background and the camera angle unchanged.'}]
    for case in cases:
        for seed in ([2026092203] if args.capabilities else plan['seeds']):
            if (case['id'],seed) in done:
                continue
            extra={}
            if case['id']=='capability_edit':
                source=ROOT/'results/qwen/03_composition_2026092201.png'
                extra['image_b64']=base64.b64encode(source.read_bytes()).decode()
            record={'test_id':case['id'],'provider':provider,'model':model,'seed':seed,'prompt':case['prompt'],'criteria':case.get('criteria'),'expected_text':case.get('expected_text'),'started_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
            try:
                record.update(run_one(base,model,case['prompt'],seed,out/f"{case['id']}_{seed}.png",key,gpu,extra))
            except urllib.error.HTTPError as exc:
                record.update({'http_status':exc.code,'error':exc.read().decode()[:1000]})
            except Exception as exc:
                record.update({'http_status':None,'error':f'{type(exc).__name__}: {exc}'})
            with results_path.open('a') as stream:
                stream.write(json.dumps(record,ensure_ascii=False)+'\n')
            print('RESULT',provider,case['id'],seed,record['http_status'],round(record.get('elapsed_seconds',0),2),record.get('error',''),flush=True)
            if record['http_status']!=200:
                raise RuntimeError('Stopped after failed request; inspect before retrying')
    print('EVALUATION_COMPLETE',provider,flush=True)

if __name__=='__main__':
    main()
