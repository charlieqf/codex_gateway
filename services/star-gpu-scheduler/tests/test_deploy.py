"""Deployment safety boundaries with fake systemd/pip and disposable files."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('scheduler_deploy',Path(__file__).resolve().parents[1]/'deploy.py')
deploy=importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class Deployment(unittest.TestCase):
    def test_source_drift_aborts_before_services_or_backups_change(self):
        manifest={'expected_current':{'qwen':'old','radar':'old'},'expected_hashes':{'source':'expected'}}
        with patch.object(deploy,'current',return_value=manifest['expected_current']),patch.object(deploy,'sha',return_value='changed'),patch.object(deploy,'verify_idle') as idle,patch.object(deploy,'ctl') as ctl:
            with self.assertRaisesRegex(AssertionError,'source drift'): deploy.prepare(manifest)
            idle.assert_not_called();ctl.assert_not_called()

    def test_pip_free_environment_is_targeted_without_dependency_resolution(self):
        with patch.object(deploy,'run',side_effect=['installed','0.1.0']) as run:
            deploy.install_wheel('/radar/bin/python','/staged/client.whl')
        command=run.call_args_list[0].args
        self.assertEqual(command[1:5],('-m','pip','--python','/radar/bin/python'))
        self.assertIn('--no-deps',command);self.assertIn('--no-index',command)

    def test_rollback_wont_start_old_code_beside_live_ct_child(self):
        with patch.object(deploy,'operator'),patch.object(deploy,'ctl'),patch.object(deploy,'run',return_value='radar-task-still-active'),patch.object(deploy.shutil,'copy2') as copy:
            with self.assertRaises(AssertionError): deploy.rollback({})
            copy.assert_not_called()

    def test_rollback_removes_worker1_start_dependency_and_preserves_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);units=root/'units';units.mkdir()
            backup=root/'backup/units';backup.mkdir(parents=True)
            for name in ('qwen-image-pool.service','qwen-image-worker@.service','radar-imaging.service'):
                (backup/name).write_text('[Unit]\nWants=qwen-image-worker@0.service qwen-image-worker@1.service\n')
            database=root/'database';database.write_bytes(b'unchanged')
            prepared={'backup':str(backup.parent),'manifest':{'expected_current':{'qwen':'original-qwen','radar':'original-radar'}}}
            with patch.object(deploy,'UNITS',units),patch.object(deploy,'operator'),patch.object(deploy,'ctl') as ctl,patch.object(deploy,'run',return_value=''),patch.object(deploy,'link'),patch.object(deploy,'health',return_value={'status':'ready'}):
                deploy.rollback(prepared)
            self.assertNotIn('worker@1.service',(units/'qwen-image-pool.service').read_text())
            self.assertEqual(database.read_bytes(),b'unchanged')
            self.assertIn(('disable','qwen-image-worker@1.service','star-gpu-scheduler.service'),[call.args for call in ctl.call_args_list])


if __name__=='__main__': unittest.main()
