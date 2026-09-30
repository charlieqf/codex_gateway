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
    def test_followup_release_only_replaces_image_and_rejects_config_drift(self):
        original='services:\n  gateway:\n    volumes:\n    - old:/old:ro\n    image: old-image\n    environment:\n      OTHER: "kept"\n'
        first=module.proposed_override(original,'old-image','a'*40,'subject-a,subject-b',{})
        env={}
        for line in first.splitlines():
            if line.strip().startswith('GATEWAY_'):
                key,value=line.strip().split(': ',1); env[key]=json.loads(value)
        second=module.proposed_override(first,'codex_gateway_r760-gateway:'+'a'*40,'b'*40,'subject-a,subject-b',env)
        self.assertEqual(second,first.replace('gateway:'+'a'*40,'gateway:'+'b'*40))
        env['GATEWAY_AIPAL_ACTIVE_JOBS']='2'
        with self.assertRaisesRegex(AssertionError,'differs from approved'):
            module.proposed_override(first,'codex_gateway_r760-gateway:'+'a'*40,'b'*40,'subject-a,subject-b',env)

    def test_followup_release_preserves_verified_nginx_include(self):
        with tempfile.TemporaryDirectory() as d:
            release=pathlib.Path(d); config=release/'config/nginx/clinical-location.conf'; config.parent.mkdir(parents=True); config.write_text('verified route')
            nginx='server {\n    include /old/imaging-location.conf;\n    location / {}\n}\n'
            first=module.proposed_vhost(nginx,release)
            self.assertEqual(module.proposed_vhost(first,release),first)
            other=release/'new'; new_config=other/'config/nginx/clinical-location.conf'; new_config.parent.mkdir(parents=True); new_config.write_text('changed route')
            with self.assertRaisesRegex(AssertionError,'route differs'):
                module.proposed_vhost(first,other)

    def test_new_mounts_preserve_both_legal_yaml_sequence_indents(self):
        for indent in ('    ','      '):
            original='  gateway:\n    volumes:\n'+indent+'- old:/old:ro\n    image: old-image\n    environment:\n      OTHER: "kept"\n'
            proposed=module.insert_mounts(original,['new:/new:ro'])
            self.assertIn('    volumes:\n'+indent+'- new:/new:ro\n'+indent+'- old:/old:ro\n',proposed)
            self.assertIn('      OTHER: "kept"',proposed)

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
