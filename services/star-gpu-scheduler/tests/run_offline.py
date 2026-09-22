"""Hard guard: no model imports, GPU tools, real services, or external sockets."""
import importlib.abc
import os
from pathlib import Path
import socket
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ['PYTHONPATH'] = str(ROOT)
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['QWEN_IMAGE_API_KEY'] = 'unit-test-key-with-at-least-32-characters'
for name in list(os.environ):
    if name.startswith('GPU_SCHEDULER_'):
        os.environ.pop(name)


class NoModels(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, *args):
        if fullname.split('.')[0] in ('torch', 'diffusers', 'transformers', 'inference_demo', 'indextts'):
            raise RuntimeError('Offline test blocked model import: '+fullname)


def audit(event, args):
    if event == 'socket.connect':
        address = args[1]
        if isinstance(address, tuple) and address[0] not in ('127.0.0.1', '::1'):
            raise RuntimeError('Offline test blocked external socket')
    if event == 'subprocess.Popen':
        command = ' '.join(map(str, args[1])) if isinstance(args[1], (list, tuple)) else str(args[1])
        if any(word in command for word in ('nvidia-smi', 'systemctl', 'systemd-run', 'run_model.py', 'smoke.py')):
            raise RuntimeError('Offline test blocked live command')


sys.meta_path.insert(0, NoModels())
sys.addaudithook(audit)
suite = unittest.defaultTestLoader.discover(str(ROOT/'tests'), pattern='test_*.py')
qwen = ROOT.parents[1]/'scripts/experiments/qwen-image-21-eval'
if importlib.util.find_spec('fastapi') and importlib.util.find_spec('httpx'):
    suite.addTests(unittest.TestLoader().discover(str(qwen), pattern='test_*.py', top_level_dir=str(qwen)))
if len(sys.argv) == 2:
    radar = Path(sys.argv[1]).resolve()
    suite.addTests(unittest.TestLoader().discover(str(radar), pattern='test_*.py', top_level_dir=str(radar)))
result = unittest.TextTestRunner(verbosity=2).run(suite)
print('OFFLINE_GUARD: models, GPU commands and external connections blocked', flush=True)
sys.exit(not result.wasSuccessful())
