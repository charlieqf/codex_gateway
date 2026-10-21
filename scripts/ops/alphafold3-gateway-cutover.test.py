"""Offline configuration-boundary tests; no infrastructure changes."""
import importlib.util
import pathlib
import sys
import tempfile
import types
import unittest

try:
    import fcntl
except ImportError:
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)

spec = importlib.util.spec_from_file_location('echo_cutover', pathlib.Path(__file__).with_name('alphafold3-gateway-cutover.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AlphaFold3CutoverTests(unittest.TestCase):
    def test_only_gateway_changes_and_existing_services_keep_settings(self):
        original = 'services:\n  gateway:\n    image: old-image\n    environment:\n      GATEWAY_ALPHAFOLD_MODE: authenticated\n      KEEP: value\n    volumes:\n    - old:/old:ro\n  worker:\n    image: old-image\n'
        proposed = module.proposed_override(original, 'old-image', 'a'*40)
        self.assertTrue(proposed.endswith('  worker:\n    image: old-image\n'))
        self.assertIn('      GATEWAY_ALPHAFOLD_MODE: authenticated\n      KEEP: value\n', proposed)
        self.assertIn('    - old:/old:ro', proposed)
        for mode in ('ALPHAFOLD3',):
            self.assertIn('GATEWAY_'+mode+'_MODE: "authenticated"', proposed)
            self.assertIn('GATEWAY_'+mode+'_SUBJECT_IDS: ""', proposed)
        self.assertEqual(proposed.count('/star-service.token:ro'), 1)
        self.assertNotIn('service.key', proposed)
        with self.assertRaises(AssertionError): module.proposed_override(proposed, 'codex_gateway_r760-gateway:'+'a'*40, 'b'*40)

    def test_nginx_update_only_extends_existing_clinical_modes(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d); old = root/'old/config/nginx/clinical-location.conf'; new = root/'new/config/nginx/clinical-location.conf'
            old.parent.mkdir(parents=True); new.parent.mkdir(parents=True)
            old.write_text('location (aipal|panecho|echonet|echonext|alphafold) {\n    proxy_cache off;\n    gzip off;\n}\n')
            new.write_text('location (aipal|panecho|echonet|echonext|alphafold|alphafold3) {\n    proxy_cache off;\n    gzip off;\n}\n')
            original = 'server {\n    include '+old.as_posix()+';\n}\n'
            self.assertEqual(module.proposed_vhost(original, root/'new'), original.replace(old.as_posix(), str(new)))
            new.write_text('unreviewed route')
            with self.assertRaises(AssertionError): module.proposed_vhost(original, root/'new')


if __name__ == '__main__': unittest.main()
