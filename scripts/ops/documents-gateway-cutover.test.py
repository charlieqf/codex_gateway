"""Offline release-boundary checks; no infrastructure changes."""
import copy
import importlib.util
import pathlib
import sys
import types
import unittest

try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
spec = importlib.util.spec_from_file_location('documents_cutover', pathlib.Path(__file__).with_name('documents-gateway-cutover.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CutoverTests(unittest.TestCase):
    def test_only_gateway_image_and_named_settings_change(self):
        original = 'services:\n  gateway:\n    image: old-image\n    environment:\n      KEEP: value\n    volumes:\n    - old:/old:ro\n  worker:\n    image: old-image\n'
        proposed = m.proposed_override(original, 'old-image', 'a'*40)
        self.assertTrue(proposed.endswith('  worker:\n    image: old-image\n'))
        self.assertIn('      KEEP: value\n', proposed)
        self.assertIn('    - old:/old:ro\n', proposed)
        self.assertEqual(proposed.count('CODEX_DOCUMENT_EVIDENCE_'), 2)
        self.assertNotIn('SUBJECTS', proposed)
        with self.assertRaises(AssertionError): m.proposed_override(proposed, 'codex_gateway_r760-gateway:'+'a'*40, 'b'*40)

    def test_vhost_preserves_all_existing_routes(self):
        original = 'server {\n    client_max_body_size 20m;\n    include /old/config/nginx/clinical-location.conf;\n    location /v1 { proxy_pass http://old; }\n}\n'
        result = m.proposed_vhost(original, pathlib.Path('/release'))
        added = '\n    include /release/config/nginx/documents-location.conf;'
        self.assertEqual(result.replace(added, ''), original)
        with self.assertRaises(AssertionError): m.proposed_vhost(result, pathlib.Path('/other'))

    def test_rejects_model_environment_ports_or_existing_mount_changes(self):
        old = {'Config': {'Env': ['MODEL=unchanged']}, 'HostConfig': {'PortBindings': {}},
               'Mounts': [{'Destination': '/old', 'Source': '/state', 'RW': True, 'Type': 'volume'}]}
        new = copy.deepcopy(old)
        new['Config']['Env'] += [k+'='+v for k, v in m.SETTINGS.items()]
        new['Mounts'].append({'Destination': m.DESTINATION, 'Source': str(m.SECRET), 'RW': False, 'Type': 'bind'})
        m.verify_configuration(old, new)
        for kind in ('environment', 'port', 'mount', 'writable_secret'):
            bad = copy.deepcopy(new)
            if kind == 'environment': bad['Config']['Env'][0] = 'MODEL=changed'
            if kind == 'port': bad['HostConfig']['PortBindings']['8101/tcp'] = []
            if kind == 'mount': bad['Mounts'][0]['Source'] = '/other'
            if kind == 'writable_secret': bad['Mounts'][1]['RW'] = True
            with self.assertRaises(AssertionError): m.verify_configuration(old, bad)


if __name__ == '__main__': unittest.main()
