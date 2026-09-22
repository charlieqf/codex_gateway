"""Finish a stopped download using validated HTTP ranges; preserve all source files."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.parse
import urllib.request

ROOT=Path('/data/apps/qwen-image-21-eval')
MODEL=ROOT/'model'
STATE=ROOT/'state'

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''):
            h.update(block)
    return h.hexdigest()

def fetch(job):
    item,start,end,path=job
    length=end-start+1
    if path.exists() and path.stat().st_size==length:
        return path
    url='https://modelscope.cn/api/v1/models/Qwen/Qwen-Image-2.1/repo?'+urllib.parse.urlencode({'Revision':item['Revision'],'FilePath':item['Path']})
    for attempt in range(4):
        try:
            request=urllib.request.Request(url,headers={'Range':f'bytes={start}-{end}'})
            with urllib.request.urlopen(request,timeout=90) as response:
                assert response.status==206
                assert response.headers['Content-Range']==f'bytes {start}-{end}/{item["Size"]}'
                with path.open('wb') as output:
                    while data:=response.read(8*1024*1024):
                        output.write(data)
            assert path.stat().st_size==length
            print('RANGE_OK',item['Path'],start,end,flush=True)
            return path
        except Exception as error:
            if attempt==3:
                raise
            print('RETRY_RANGE',start,type(error).__name__,flush=True)
            time.sleep(3)

def main():
    os.umask(0o077)
    started=time.time()
    files=[x for x in json.loads((STATE/'model-manifest.json').read_text())['Data']['Files'] if x['Type']=='blob' and not x['Path'].startswith('assets/')]
    jobs=[]
    pending=[]
    for item in files:
        target=(MODEL/item['Path']).resolve()
        assert target.is_relative_to(MODEL.resolve())
        if target.exists():
            assert target.stat().st_size==item['Size']
            continue
        partial=target.with_name(target.name+'.partial')
        offset=partial.stat().st_size if partial.exists() else 0
        assert offset<=item['Size']
        chunks=STATE/'download-ranges'/item['Path'].replace('/','_')
        chunks.mkdir(parents=True,exist_ok=True)
        parts=[]
        for start in range(offset,item['Size'],256*1024*1024):
            end=min(start+256*1024*1024,item['Size'])-1
            path=chunks/f'{start}-{end}.part'
            job=(item,start,end,path)
            jobs.append(job)
            parts.append(job)
        pending.append((item,target,partial,offset,parts))
    print('PARALLEL_FINISH_START',len(jobs),sum(end-start+1 for _,start,end,_ in jobs),flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch,jobs))
    for item,target,partial,offset,parts in pending:
        assert (partial.stat().st_size if partial.exists() else 0)==offset,'Original downloader is still writing'
        with partial.open('ab') as output:
            for _,_,_,path in parts:
                with path.open('rb') as source:
                    while data:=source.read(8*1024*1024):
                        output.write(data)
        assert partial.stat().st_size==item['Size']
        assert digest(partial)==item['Sha256']
        os.replace(partial,target)
        print('VERIFIED',item['Path'],flush=True)
    for item in files:
        assert digest(MODEL/item['Path'])==item['Sha256']
    summary={'source':'official ModelScope mirror','completed_files':len(files),'bytes':sum(x['Size'] for x in files),'sha256_verified':True,'parallel_finish_seconds':time.time()-started}
    (STATE/'download-complete.json').write_text(json.dumps(summary,indent=2))
    print('DOWNLOAD_COMPLETE',json.dumps(summary),flush=True)

if __name__=='__main__':
    main()
