import argparse
import json
from pathlib import Path
import tarfile
from PIL import Image

ROOT=Path('/data/apps/qwen-image-21-eval')
parser=argparse.ArgumentParser()
parser.add_argument('provider',choices=['llada','qwen'])
args=parser.parse_args()
source=ROOT/'results'/args.provider
review=ROOT/'results'/(args.provider+'-review')
review.mkdir(exist_ok=True)
for path in sorted(source.glob('*.png')):
    if path.name=='warmup.png':
        continue
    with Image.open(path) as image:
        if image.mode=='RGBA':
            canvas=Image.new('RGB',image.size,'white')
            canvas.paste(image,mask=image.getchannel('A'))
        else:
            canvas=image.convert('RGB')
        canvas.save(review/(path.stem+'.jpg'),quality=93,subsampling=0)
archive=ROOT/'state'/(args.provider+'-review.tar.gz')
with tarfile.open(archive,'w:gz') as tar:
    tar.add(review,arcname=review.name)
    tar.add(ROOT/'results'/(args.provider+'-results.jsonl'),arcname=args.provider+'-results.jsonl')
    tar.add(source/'warmup.json',arcname=args.provider+'-warmup.json')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'images':len(list(review.glob('*.jpg')))}))
