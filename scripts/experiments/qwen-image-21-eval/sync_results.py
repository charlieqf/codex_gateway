"""Copy only synthetic evaluation results over SSH, never service secrets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument('provider',choices=['llada','qwen'])
parser.add_argument('destination',type=Path)
args=parser.parse_args()
root=args.destination
root.mkdir(parents=True,exist_ok=True)
local=root/args.provider
local.mkdir(exist_ok=True)
identity=str(Path.home()/'.ssh/id_ed25519')
host='aiuser@117.186.49.26'
remote='/data/apps/qwen-image-21-eval/results/'
ssh=['ssh','-p','7722','-i',identity,'-o','BatchMode=yes','-o','ConnectTimeout=10',host]
result=subprocess.run(ssh+['cat '+remote+args.provider+'-results.jsonl'],capture_output=True,check=True)
rows=[json.loads(line) for line in result.stdout.decode().splitlines() if line.strip()]
missing=[]
for row in rows:
    if row.get('http_status')!=200:
        continue
    path=row['file']
    assert re.fullmatch(args.provider+r'/[a-z0-9_]+\.png',path),path
    target=root/path
    if not target.exists():
        missing.append(host+':'+remote+path)
if missing:
    subprocess.run(['scp','-P','7722','-i',identity,'-o','BatchMode=yes',*missing,str(local)],check=True)
for row in rows:
    if row.get('http_status')==200:
        assert hashlib.sha256((root/row['file']).read_bytes()).hexdigest()==row['sha256']
(root/(args.provider+'-results.jsonl')).write_bytes(result.stdout)
print(json.dumps({'provider':args.provider,'records':len(rows),'downloaded':len(missing),'all_copied_images_sha256_verified':True}))
