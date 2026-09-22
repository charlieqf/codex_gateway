"""Download official ModelScope files at their observed revisions and verify SHA256."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request

ROOT = Path('/data/apps/qwen-image-21-eval')
MODEL = ROOT / 'model'
STATE = ROOT / 'state'
API = 'https://modelscope.cn/api/v1/models/Qwen/Qwen-Image-2.1'

def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def download(item):
    name = item['Path']
    dest = (MODEL / name).resolve()
    if not dest.is_relative_to(MODEL.resolve()):
        raise ValueError('Unsafe model path')
    dest.parent.mkdir(parents=True, exist_ok=True)
    expected = item['Sha256']
    if dest.exists() and dest.stat().st_size == item['Size'] and sha256(dest) == expected:
        print('VERIFIED_EXISTING', name, flush=True)
        return name
    partial = dest.with_name(dest.name + '.partial')
    url = API + '/repo?' + urllib.parse.urlencode({'Revision': item['Revision'], 'FilePath': name})
    for attempt in range(4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            req = urllib.request.Request(url, headers={'User-Agent':'qwen21-research-evaluation', **({'Range':f'bytes={offset}-'} if offset else {})})
            with urllib.request.urlopen(req, timeout=90) as response:
                append = offset > 0 and response.status == 206
                with partial.open('ab' if append else 'wb') as f:
                    while block := response.read(8 * 1024 * 1024):
                        f.write(block)
            if partial.stat().st_size != item['Size']:
                raise ValueError('File size mismatch: ' + name)
            if sha256(partial) != expected:
                raise ValueError('SHA256 mismatch: ' + name)
            os.replace(partial, dest)
            print('VERIFIED', name, item['Size'], flush=True)
            return name
        except Exception as error:
            print('RETRY', name, attempt + 1, type(error).__name__, str(error)[:160], flush=True)
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))

def main():
    os.umask(0o077)
    MODEL.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    manifest = STATE / 'model-manifest.json'
    if manifest.exists():
        payload = json.loads(manifest.read_text())
    else:
        with urllib.request.urlopen(API + '/repo/files?Revision=master&Recursive=true', timeout=30) as r:
            payload = json.load(r)
        manifest.write_text(json.dumps(payload, indent=2))
    files = [x for x in payload['Data']['Files'] if x['Type']=='blob' and not x['Path'].startswith('assets/')]
    assert all(x.get('Sha256') and x.get('Revision') for x in files)
    print('DOWNLOAD_START', len(files), sum(x['Size'] for x in files), flush=True)
    started = time.time()
    with ThreadPoolExecutor(max_workers=3) as pool:
        completed = list(pool.map(download, files))
    summary = {'source':API,'completed_files':len(completed),'bytes':sum(x['Size'] for x in files),'sha256_verified':True,'elapsed_seconds':time.time()-started}
    (STATE / 'download-complete.json').write_text(json.dumps(summary, indent=2))
    print('DOWNLOAD_COMPLETE', json.dumps(summary), flush=True)

if __name__ == '__main__':
    main()
