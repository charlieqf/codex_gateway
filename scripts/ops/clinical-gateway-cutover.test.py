"""Offline rollout safety tests. No Docker, network or service mutations."""
import importlib.util, json, pathlib, tempfile, types, unittest
from unittest.mock import patch

try:
    import fcntl
except ImportError:
    import sys
    sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *_:None)

spec=importlib.util.spec_from_file_location('clinical_cutover',pathlib.Path(__file__).with_name('clinical-gateway-cutover.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class Response:
    status=200
    def __init__(self,ready=True): self.ready=ready
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self): return json.dumps({'state':'ready' if self.ready else 'starting','lifecycle':{'draining':False}}).encode()

class RolloutTests(unittest.TestCase):
    def test_public_health_requires_two_consecutive_ready_responses(self):
        with tempfile.TemporaryDirectory() as d, patch.object(module.urllib.request,'urlopen',side_effect=[Response(False),Response(),Response()]) as probe, patch.object(module.time,'sleep'):
            path=pathlib.Path(d)/'events.json'; module.converge(path)
            self.assertEqual(probe.call_count,3); self.assertEqual([x['ready'] for x in json.loads(path.read_text())],[False,True,True])

    def test_public_health_deadline_records_failure(self):
        with tempfile.TemporaryDirectory() as d, patch.object(module.time,'monotonic',side_effect=[0,61]):
            path=pathlib.Path(d)/'events.json'
            with self.assertRaisesRegex(RuntimeError,'convergence failed'): module.converge(path)
            self.assertEqual(json.loads(path.read_text()),[])

    def test_http_authentication_failure_does_not_loop(self):
        error=module.urllib.error.HTTPError('https://example.invalid',401,'invalid',{},None)
        with tempfile.TemporaryDirectory() as d, patch.object(module.urllib.request,'urlopen',side_effect=error) as probe:
            path=pathlib.Path(d)/'events.json'
            with self.assertRaises(RuntimeError): module.converge(path)
            self.assertEqual(probe.call_count,1); self.assertEqual(json.loads(path.read_text())[0]['status'],401)

if __name__=='__main__': unittest.main()
