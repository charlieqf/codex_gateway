"""Check final evaluation coverage and portable report references; no browser claims."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('artifacts',type=Path)
    args=parser.parse_args()
    root=args.artifacts.resolve()
    plan=json.loads((root/'evaluation_plan.json').read_text(encoding='utf-8-sig'))
    expected={(case['id'],seed) for case in plan['cases'] for seed in plan['seeds']}
    verified=0
    for provider in ('llada','qwen'):
        rows=[json.loads(line) for line in (root/f'{provider}-results.jsonl').read_text(encoding='utf-8-sig').splitlines()]
        shared=[r for r in rows if not r['test_id'].startswith('capability_')]
        assert len(shared)==len(expected)
        assert {(r['test_id'],r['seed']) for r in shared}==expected
        if provider=='qwen':
            assert {r['test_id'] for r in rows if r['test_id'].startswith('capability_')}=={'capability_transparency','capability_edit'}
        for row in rows:
            assert row['http_status']==200,row
            path=(root/row['file']).resolve()
            assert path.is_relative_to(root)
            raw=path.read_bytes()
            assert hashlib.sha256(raw).hexdigest()==row['sha256'],path
            with Image.open(path) as img:
                img.load()
                assert img.size==(1024,1024) and img.format=='PNG',path
            verified+=1
    reviews=json.loads((root/'visual-review.json').read_text(encoding='utf-8'))
    assert len(reviews['pairs'])==len(expected)
    assert {(r['test_id'],r['seed']) for r in reviews['pairs']}==expected
    assert len(reviews['capabilities'])==2
    class References(HTMLParser):
        def __init__(self):
            super().__init__()
            self.references=[]
        def handle_starttag(self,tag,attrs):
            for key,value in attrs:
                if key in ('href','src') and value and not urlsplit(value).scheme:
                    self.references.append(value)
    html=(root/'comparison.html').read_text(encoding='utf-8')
    refs=References()
    refs.feed(html)
    for value in refs.references:
        path=(root/value).resolve()
        assert path.is_relative_to(root) and path.is_file(),value
    result={'original_pngs_verified':verified,'shared_pairs_reviewed':len(expected),'html_local_references_verified':len(refs.references),'browser_render_verified':False,'browser_render_limitation':'CUA initialization failed; shell browser rendering was rejected by automatic policy review.'}
    (root/'validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':
    main()
