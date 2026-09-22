"""Public Qwen primary smoke with temporary credential/entitlement cleanup."""
import base64
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error

CONTAINER='codex_gateway_r760-gateway-1'
ORIGIN='https://goldencode.instmarket.com.au:1443'


def admin(*args):
    p=subprocess.run(['docker','exec',CONTAINER,'node','/app/apps/admin-cli/dist/index.js','--db','/var/lib/codex-gateway/gateway.db',*args],capture_output=True,check=True)
    return json.loads(p.stdout)


def request(path,token,body=None):
    req=urllib.request.Request(ORIGIN+path,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req,timeout=240) as r:
            return r.status,dict(r.headers),json.load(r)
    except urllib.error.HTTPError as e:
        return e.code,dict(e.headers),json.load(e)


def main():
    output=Path(sys.argv[1]); output.mkdir(parents=True,exist_ok=True)
    label='qwen-image-smoke-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    token=prefix=entitlement=None
    result={'started_utc':datetime.now(timezone.utc).isoformat(),'public_model':'medcode-image-default'}
    try:
        fixture=admin('issue','--user',label,'--user-label','Qwen image controlled smoke','--label',label,'--scope','code','--credential-class','service','--expires-days','1','--rpm','10','--rpd','20','--concurrent','1','--tokens-per-minute','300000','--tokens-per-day','1000000','--tokens-per-month','10000000','--max-prompt-tokens','24576','--max-total-tokens','32768','--reserve-tokens','8192','--missing-usage-charge','reserve')
        token=fixture['token']; prefix=fixture['credential']['prefix']
        entitlement=admin('entitlement','grant','--user',label,'--plan','plan_paid_monthly_v1','--period','one_off','--duration','1h','--replace')['entitlement']['id']
        started=time.monotonic()
        status,headers,payload=request('/gateway/images/generations',token,{'model':'medcode-image-default','prompt':'A simple teal education poster on a white background with exactly this Chinese title: 每天运动，健康生活. Three clean icons below: walking, cycling, swimming. No other text.','size':'1024x1024','quality':'low','output_format':'jpeg','output_compression':20,'metadata':{'client':'qwen-primary-cutover-smoke'}})
        assert status==200,{'status':status,'error':payload.get('error')}
        rid=next(value for key,value in headers.items() if key.lower()=='x-request-id')
        image=payload['data'][0]
        raw=base64.b64decode(image['b64_json'],validate=True)
        assert image['mime_type']=='image/jpeg' and raw[:3]==b'\xff\xd8\xff' and raw[-2:]==b'\xff\xd9'
        (output/'public-qwen-smoke.jpg').write_bytes(raw)
        events=admin('events','--request-id',rid,'--limit','5')['events']
        assert any(e['provider']=='qwen-image' and e['upstream_model']=='qwen-image-2.1' and e['status']=='ok' for e in events), 'Expected Qwen primary, not a fallback'
        result['image']={'status':status,'request_id':rid,'elapsed_seconds':time.monotonic()-started,'provider':'qwen-image','upstream_model':'qwen-image-2.1','mime_type':image['mime_type'],'sha256':hashlib.sha256(raw).hexdigest()}
        status,headers,payload=request('/v1/chat/completions',token,{'model':'goldencode','messages':[{'role':'user','content':'Reply exactly TEXT_CONTROL_OK.'}],'max_tokens':256,'reasoning_effort':'low','stream':False})
        assert status==200 and payload['choices'][0]['message']['content']
        result['text']={'status':status,'request_id':next(value for key,value in headers.items() if key.lower()=='x-request-id')}
        logs=subprocess.check_output(['docker','logs','--since',result['started_utc'],CONTAINER],stderr=subprocess.STDOUT)
        assert token.encode() not in logs and b'TEXT_CONTROL_OK' not in logs
        result['log_secret_scan']='clean'
    finally:
        cleanup={}
        # Attempt every cleanup even if one operation fails; report failures, never a token.
        for name,args in [('credential',('revoke',prefix) if prefix else None),('entitlement',('entitlement','cancel',entitlement,'--reason','Qwen primary smoke completed') if entitlement else None),('subject',('disable-user',label))]:
            if args:
                try: admin(*args); cleanup[name]='revoked/cancelled/disabled'
                except Exception as e: cleanup[name]=type(e).__name__
        if token:
            cleanup['revoked_key_http']=request('/v1/models',token)[0]
        result['cleanup']=cleanup
        (output/'public-smoke.json').write_text(json.dumps(result,indent=2)+'\n')
        assert cleanup.get('revoked_key_http')==401 and all(v=='revoked/cancelled/disabled' for k,v in cleanup.items() if k!='revoked_key_http'), 'Smoke cleanup incomplete'
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    main()
