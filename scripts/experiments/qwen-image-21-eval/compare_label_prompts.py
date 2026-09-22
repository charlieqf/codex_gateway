"""Fixed-seed, medium/PNG/square comparison of exact client-supplied prompts."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.request

from PIL import Image


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('source',type=Path); parser.add_argument('output',type=Path)
    args=parser.parse_args(); args.output.mkdir(mode=0o700,parents=True,exist_ok=True)
    source=json.loads(args.source.read_text(encoding='utf-8-sig'))
    prompts=[]
    for request in source['requests']:
        prompt=request['body']['prompt']; digest=hashlib.sha256(prompt.encode()).hexdigest()
        assert digest==request['prompt_sha256_utf8'], 'Client prompt checksum mismatch'
        if not any(p['sha256']==digest for p in prompts):
            prompts.append({'id':len(prompts)+1,'prompt':prompt,'sha256':digest,'reference_request':request['request_id']})
    assert len(prompts)==3
    key=next(l.split('=',1)[1] for l in Path('/data/apps/qwen-image-21-eval/api.env').read_text().splitlines() if l.startswith('QWEN_IMAGE_API_KEY='))
    plan={'source_sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'source_provenance':source['provenance'],'started_utc':datetime.now(timezone.utc).isoformat(),
        'prompts':prompts,'seeds':[2026092201,2026092202,2026092203,2026092204],
        'controls':{'model':'qwen-image-2.1','size':'1024x1024','quality':'medium','format':'png','steps':40,'cfg':1,'profile':'BF16 model CPU offload'},
        'quality_note':'Current Qwen worker does not map high/medium/low to inference parameters; all use the fixed profile.',
        'samples':[]}
    (args.output/'plan.json').write_text(json.dumps(plan,indent=2,ensure_ascii=False)+'\n')
    def one(case):
        prompt,seed=case
        body={'model':'qwen-image-2.1','prompt':prompt['prompt'],'seed':seed,'size':'1024x1024','quality':'medium','output_format':'png','response_format':'b64_json','num_inference_steps':40}
        started=time.monotonic()
        req=urllib.request.Request('http://127.0.0.1:8191/v1/images/generations',data=json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
        with urllib.request.urlopen(req,timeout=180) as r:
            assert r.status==200;data=json.load(r)
        raw=base64.b64decode(data['data'][0]['b64_json'],validate=True)
        image=Image.open(io.BytesIO(raw));image.load();assert image.size==(1024,1024) and image.format=='PNG'
        name=f"prompt-{prompt['id']}-seed-{seed}.png"
        (args.output/name).write_bytes(raw)
        return {'prompt_id':prompt['id'],'prompt_sha256':prompt['sha256'],'seed':seed,'file':name,'image_sha256':hashlib.sha256(raw).hexdigest(),'seconds':time.monotonic()-started,'evaluation':data['evaluation'],'dispatch':data['dispatch']}
    cases=[(prompt,seed) for prompt in prompts for seed in plan['seeds']]
    for index in range(0,len(cases),2):
        with ThreadPoolExecutor(max_workers=2) as pool:
            samples=list(pool.map(one,cases[index:index+2]))
        plan['samples'].extend(samples)
        (args.output/'results.json').write_text(json.dumps(plan,indent=2,ensure_ascii=False)+'\n')
        print(json.dumps({'completed':len(plan['samples']),'samples':samples},ensure_ascii=False),flush=True)
    plan['status']='generated-awaiting-visual-review'
    (args.output/'results.json').write_text(json.dumps(plan,indent=2,ensure_ascii=False)+'\n')


if __name__=='__main__':
    main()
