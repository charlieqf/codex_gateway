"""Offline tests for immediate AF2 retirement after successful AF3 acceptance."""
import importlib.util,json,pathlib,sys,tempfile,types,unittest
try:
    import fcntl
except ImportError:
    sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=1,LOCK_NB=2,flock=lambda *_:None)
spec=importlib.util.spec_from_file_location('retire_af2',pathlib.Path(__file__).with_name('retire-alphafold-r760.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RetirementTests(unittest.TestCase):
    def test_only_af2_configuration_and_mounts_are_removed(self):
        initial='services:\n  gateway:\n    image: old-image\n    environment:\n      KEEP: original\n    volumes:\n    - old:/old:ro\n  worker:\n    image: old-image\n'
        old=module.af3.idle_module.proposed_override(initial,'old-image','a'*40)
        both=module.af3.proposed_override(old,'codex_gateway_r760-gateway:'+'a'*40,'b'*40).replace('\\','/')
        final=module.proposed_override(both,'codex_gateway_r760-gateway:'+'b'*40,'c'*40)
        self.assertNotIn('GATEWAY_ALPHAFOLD_',final)
        self.assertNotIn('/run/secrets/alphafold/',final)
        self.assertIn('GATEWAY_ALPHAFOLD3_MODE: "authenticated"',final)
        self.assertEqual(final.count('/star-service.token:ro'),1)
        self.assertIn('      KEEP: original\n',final)
        self.assertIn('    - old:/old:ro\n',final)
        self.assertTrue(final.endswith('  worker:\n    image: old-image\n'))
        with self.assertRaises(AssertionError):module.proposed_override(final,'codex_gateway_r760-gateway:'+'c'*40,'d'*40)
        with self.assertRaises(AssertionError):module.proposed_override(both.replace('GATEWAY_ALPHAFOLD_DAILY_JOBS','UNREVIEWED_AF2_KEY'),'codex_gateway_r760-gateway:'+'b'*40,'c'*40)

    def test_nginx_only_drops_the_retired_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);old=root/'old/config/nginx/clinical-location.conf';new=root/'new/config/nginx/clinical-location.conf'
            old.parent.mkdir(parents=True);new.parent.mkdir(parents=True)
            old.write_text('location (aipal|panecho|echonet|echonext|alphafold|alphafold3) {\n    gzip off;\n}\n')
            new.write_text(old.read_text().replace('echonext|alphafold|alphafold3','echonext|alphafold3'))
            original='server {\n    include '+old.as_posix()+';\n}\n'
            self.assertEqual(module.proposed_vhost(original,root/'new'),original.replace(old.as_posix(),str(new)))
            new.write_text('unreviewed change')
            with self.assertRaises(AssertionError):module.proposed_vhost(original,root/'new')

    def test_rejects_a_missing_prediction_or_incomplete_cancellation_receipt(self):
        receipt={'status':'passed','capabilities':{'available':True,'analysis_profile':'alphafold3-monomer-public-msa-v1'},'artifacts':[{'verified':True}]*7,
                 'jobs':[{'state':'completed','deleted':True},{'state':'cancelled','phase_at_cancel':'predicting','deleted':True}]}
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'receipt.json';path.write_text(json.dumps(receipt));module.accepted(path)
            for change in ({'status':'failed'},{'artifacts':receipt['artifacts'][:6]},{'jobs':[receipt['jobs'][0]]}):
                path.write_text(json.dumps({**receipt,**change}))
                with self.assertRaises(AssertionError):module.accepted(path)

if __name__=='__main__':unittest.main()
