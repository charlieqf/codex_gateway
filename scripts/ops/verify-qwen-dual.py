"""Bounded private throughput and public two-request acceptance; no secret output."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import threading
import time
import urllib.request
import urllib.error

PROMPT = 'A clean white education poster with the exact Chinese title 每天运动，健康生活 in teal. Exactly three simple icons below: walking, cycling, swimming. No other text.'


def private(output):
    key = next(l.split('=',1)[1] for l in Path('/data/apps/qwen-image-21-eval/api.env').read_text().splitlines() if l.startswith('QWEN_IMAGE_API_KEY='))
    from PIL import Image
    samples=[]; stop=threading.Event()
    def sample():
        while not stop.is_set():
            raw=subprocess.check_output(['nvidia-smi','--query-gpu=index,temperature.gpu,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True)
            samples.append({'seconds':time.monotonic(),'gpus':[[int(v.strip()) for v in l.split(',')] for l in raw.strip().splitlines()]})
            stop.wait(1)
    watcher=threading.Thread(target=sample,daemon=True); watcher.start()
    def one(index):
        started=time.monotonic()
        req=urllib.request.Request('http://127.0.0.1:8191/v1/images/generations',headers={'Content-Type':'application/json','Authorization':'Bearer '+key},data=json.dumps({'prompt':PROMPT,'size':'1024x1024','seed':2026092200+index,'model':'qwen-image-2.1'}).encode())
        try:
            with urllib.request.urlopen(req,timeout=180) as r:
                status=r.status; data=json.load(r)
        except urllib.error.HTTPError as e:
            return {'index':index,'status':e.code,'seconds':time.monotonic()-started,'error':json.load(e)}
        raw=base64.b64decode(data['data'][0]['b64_json'],validate=True)
        image=Image.open(io.BytesIO(raw)); image.load(); assert image.size==(1024,1024)
        (output/f'private-{index}.png').write_bytes(raw)
        return {'index':index,'status':status,'started':started,'finished':time.monotonic(),'seconds':time.monotonic()-started,'sha256':hashlib.sha256(raw).hexdigest(),'dispatch':data['dispatch'],'evaluation':data['evaluation']}
    result={'started_utc':datetime.now(timezone.utc).isoformat(),'rounds':[]}
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            result['warmup']=list(pool.map(one,[-2,-1]))
        print(json.dumps({'warmup':result['warmup']},ensure_ascii=False),flush=True)
        assert all(r['status']==200 for r in result['warmup'])
        index=0
        for count in [1,2,4]:
            started=time.monotonic()
            with ThreadPoolExecutor(max_workers=count) as pool:
                rows=list(pool.map(one,range(index,index+count)))
            batch={'concurrency':count,'wall_seconds':time.monotonic()-started,'requests':rows}
            result['rounds'].append(batch); index+=count
            (output/'private-benchmark.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
            print(json.dumps(batch,ensure_ascii=False),flush=True)
            assert all(r['status']==200 for r in rows), 'Generation failed'
            if count>=2:
                assert {r['evaluation']['gpu_id'] for r in rows}=={0,1}, 'Both physical GPUs must execute'
                assert any(a['started']+a['dispatch']['queue_seconds']<b['finished'] and b['started']+b['dispatch']['queue_seconds']<a['finished'] for a in rows for b in rows if a['evaluation']['gpu_id']!=b['evaluation']['gpu_id']), 'GPU jobs did not overlap'
        result['speedup_pair_vs_single']=2*result['rounds'][0]['wall_seconds']/result['rounds'][1]['wall_seconds']
        assert len(samples)>2
        result['gpu_peak_temperature_c']={str(i):max(g[1] for s in samples for g in s['gpus'] if g[0]==i) for i in [0,1]}
        result['gpu_peak_used_mib']={str(i):max(g[2] for s in samples for g in s['gpus'] if g[0]==i) for i in [0,1]}
        result['both_gpus_utilized_samples']=sum(all(g[3]>30 for g in s['gpus']) for s in samples)
        assert result['both_gpus_utilized_samples']>0
        result['status']='verified'
    finally:
        stop.set(); watcher.join(timeout=10)
        (output/'private-benchmark.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
        (output/'gpu-samples.json').write_text(json.dumps(samples)+'\n')


def public(output):
    spec=importlib.util.spec_from_file_location('smoke',Path(__file__).with_name('smoke-qwen-image-r760.py'))
    smoke=importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
    label='qwen-dual-smoke-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    token=prefix=entitlement=None
    result={'started_utc':datetime.now(timezone.utc).isoformat()}
    try:
        fixture=smoke.admin('issue','--user',label,'--user-label','Qwen dual controlled smoke','--label',label,'--scope','code','--credential-class','service','--expires-days','1','--rpm','10','--rpd','20','--concurrent','2','--tokens-per-minute','300000','--tokens-per-day','1000000','--tokens-per-month','10000000','--max-prompt-tokens','24576','--max-total-tokens','32768','--reserve-tokens','8192','--missing-usage-charge','reserve')
        token=fixture['token']; prefix=fixture['credential']['prefix']
        entitlement=smoke.admin('entitlement','grant','--user',label,'--plan','plan_paid_monthly_v1','--period','one_off','--duration','1h','--replace')['entitlement']['id']
        def one(fmt):
            started=time.monotonic()
            status,headers,payload=smoke.request('/gateway/images/generations',token,{'model':'medcode-image-default','prompt':PROMPT,'size':'1024x1024','quality':'low','output_format':fmt,'metadata':{'client':'qwen-dual-acceptance'}})
            assert status==200, {'status':status,'error':payload.get('error')}
            rid=next(v for k,v in headers.items() if k.lower()=='x-request-id')
            item=payload['data'][0]; raw=base64.b64decode(item['b64_json'],validate=True)
            assert item['mime_type']=='image/'+fmt
            assert (fmt=='jpeg' and raw[:3]==b'\xff\xd8\xff' and raw[-2:]==b'\xff\xd9') or (fmt=='webp' and raw[:4]==b'RIFF' and raw[8:12]==b'WEBP')
            (output/('public-'+fmt+'.'+('jpg' if fmt=='jpeg' else fmt))).write_bytes(raw)
            events=smoke.admin('events','--request-id',rid,'--limit','5')['events']
            assert any(e['provider']=='qwen-image' and e['upstream_model']=='qwen-image-2.1' and e['status']=='ok' for e in events)
            return {'status':status,'request_id':rid,'seconds':time.monotonic()-started,'provider':'qwen-image','upstream_model':'qwen-image-2.1','mime_type':item['mime_type'],'sha256':hashlib.sha256(raw).hexdigest()}
        started=time.monotonic()
        with ThreadPoolExecutor(max_workers=2) as pool:
            result['images']=list(pool.map(one,['jpeg','webp']))
        result['pair_wall_seconds']=time.monotonic()-started
        status,headers,payload=smoke.request('/v1/chat/completions',token,{'model':'goldencode','messages':[{'role':'user','content':'Reply exactly TEXT_CONTROL_OK.'}],'max_tokens':256,'reasoning_effort':'low','stream':False})
        assert status==200 and payload['choices'][0]['message']['content']
        result['text']={'status':status,'request_id':next(v for k,v in headers.items() if k.lower()=='x-request-id')}
        logs=subprocess.check_output(['docker','logs','--since',result['started_utc'],smoke.CONTAINER],stderr=subprocess.STDOUT)
        assert token.encode() not in logs
        result['status']='verified'
    finally:
        cleanup={}
        for name,args in [('credential',('revoke',prefix) if prefix else None),('entitlement',('entitlement','cancel',entitlement,'--reason','Qwen dual smoke completed') if entitlement else None),('subject',('disable-user',label))]:
            if args:
                try: smoke.admin(*args); cleanup[name]='done'
                except Exception as exc: cleanup[name]=type(exc).__name__
        if token:
            cleanup['revoked_key_http']=smoke.request('/v1/models',token)[0]
        result['cleanup']=cleanup
        (output/'public-dual-smoke.json').write_text(json.dumps(result,indent=2)+'\n')
        assert cleanup.get('revoked_key_http')==401 and all(v=='done' for k,v in cleanup.items() if k!='revoked_key_http')
    print(json.dumps(result,indent=2),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['private','public']); parser.add_argument('output',type=Path)
    args=parser.parse_args(); args.output.mkdir(mode=0o700,parents=True,exist_ok=True)
    (private if args.mode=='private' else public)(args.output)
