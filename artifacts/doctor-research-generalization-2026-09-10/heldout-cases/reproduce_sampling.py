import hashlib
import json
import random
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'sampling-manifest.json').read_text(encoding='utf-8'))
rng = random.Random(manifest['seed'])
draws = []
inputs = []
for stratum in manifest['strata']:
    index = rng.randrange(len(stratum['candidates']))
    name = stratum['candidates'][index]
    draws.append({'id': stratum['id'], 'candidate_count': len(stratum['candidates']), 'selected_index_zero_based': index, 'name': name})
    inputs.append({'id': stratum['id'], 'name': name, 'institution': stratum['institution'], 'department': stratum['department']})

serialized = (json.dumps(inputs, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
input_path = root / 'inputs.json'
if input_path.exists():
    assert input_path.read_bytes() == serialized, 'Existing input differs: refusing to overwrite held-out cases'
else:
    input_path.write_bytes(serialized)
(root / 'sampling-draws.json').write_bytes((json.dumps(draws, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(json.dumps({'count':len(inputs), 'sha256':hashlib.sha256(serialized).hexdigest(), 'draws':draws}, ensure_ascii=False))
