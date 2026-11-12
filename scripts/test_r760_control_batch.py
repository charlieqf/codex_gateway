"""Regression checks for backup reuse boundaries; no production access."""
import importlib.util
import argparse
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('manage-r760-gateway-control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
runner_spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('run-r760-control-batch.py'))
runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(runner)
HEALTH = {'migration':44, 'integrity':{'quick_check':'ok','foreign_key_violations':0}}
BACKUP = {'backup_path':'/protected/test.db','sha256':'a'*64}


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.mocks={}
        for name, value in [('install_helper',None),('remove_helper_best_effort',None),
                            ('run_helper_json',HEALTH),('create_target_backup',BACKUP),
                            ('run_remote_admin',{'changed':True})]:
            p=patch.object(control,name,return_value=value)
            self.mocks[name]=p.start()
            self.addCleanup(p.stop)
        self.first=control.parse_args(['--','disable-user','test-a'])
        self.second=control.parse_args(['--','enable-user','test-a'])

    def context(self):
        return control.VerifiedControlBatch(self.first,[self.first.admin_args,self.second.admin_args])

    def test_two_writes_share_one_backup_and_final_check(self):
        with self.context() as batch:
            first=control.execute(self.first,batch=batch)
            second=control.execute(self.second,batch=batch)
            self.assertEqual(first['integrity_after']['status'],'pending_batch_final_check')
            self.assertEqual(first['backup'],second['backup'])
            self.assertIsNone(batch.after)
        self.assertEqual(self.mocks['create_target_backup'].call_count,1)
        self.assertEqual(self.mocks['run_helper_json'].call_count,2)
        self.assertEqual(self.mocks['run_remote_admin'].call_count,2)
        self.assertEqual(batch.after['quick_check'],'ok')

    def test_standalone_keeps_its_own_backup(self):
        result=control.execute(self.first)
        self.assertEqual(result['integrity_after']['quick_check'],'ok')
        self.mocks['create_target_backup'].assert_called_once()

    def test_failed_write_stops_context_and_still_checks_integrity(self):
        self.mocks['run_remote_admin'].side_effect=RuntimeError('write failed')
        with self.assertRaisesRegex(RuntimeError,'write failed'):
            with self.context() as batch:
                control.execute(self.first,batch=batch)
        self.assertTrue(batch.failed)
        self.assertEqual(batch.after['quick_check'],'ok')
        with self.assertRaises(control.ManagementError):
            batch.claim(self.second)
        self.assertEqual(self.mocks['run_remote_admin'].call_count,1)

    def test_wrong_order_or_target_cannot_write(self):
        with self.assertRaises(control.ManagementError):
            with self.context() as batch:
                control.execute(self.second,batch=batch)
        self.mocks['run_remote_admin'].assert_not_called()
        other=control.parse_args(['--r760-host','wrong-host','--',*self.first.admin_args])
        with self.assertRaises(control.ManagementError):
            with self.context() as batch:
                control.execute(other,batch=batch)
        self.mocks['run_remote_admin'].assert_not_called()

    def test_expired_context_cannot_write(self):
        with self.assertRaises(control.ManagementError):
            with self.context() as batch:
                batch.started-=1801
                control.execute(self.first,batch=batch)
        self.mocks['run_remote_admin'].assert_not_called()

    def test_failed_backup_prevents_all_writes(self):
        self.mocks['create_target_backup'].side_effect=RuntimeError('backup failed')
        with self.assertRaisesRegex(RuntimeError,'backup failed'):
            with self.context():
                self.fail('entered after failed backup')
        self.mocks['run_remote_admin'].assert_not_called()
        self.mocks['remove_helper_best_effort'].assert_called_once()

    def test_final_integrity_failure_is_not_success(self):
        self.mocks['run_helper_json'].side_effect=[HEALTH,{'integrity':{'quick_check':'bad'}}]
        with self.assertRaises(control.ManagementError):
            with self.context() as batch:
                control.execute(self.first,batch=batch)
                control.execute(self.second,batch=batch)
        self.assertIsNone(batch.after)

    def test_secret_issuance_and_global_rewrites_are_not_batch_commands(self):
        for command in [['issue','--label','secret'],['set-plan-token-limits','plan_x','1','none'],
                        ['entitlement','bulk-grant','--plan','p'],['ensure-account-rpd-minimum','500']]:
            with self.subTest(command=command), self.assertRaises(control.ManagementError):
                control.VerifiedControlBatch(self.first,[command])
        self.mocks['create_target_backup'].assert_not_called()

    def test_preview_never_creates_backup(self):
        control.execute(control.parse_args(['--what-if','--',*self.first.admin_args]))
        self.mocks['create_target_backup'].assert_not_called()
        self.mocks['run_remote_admin'].assert_not_called()

    def run_runner(self, path, *, preview=False):
        args=argparse.Namespace(resume=False,continue_on_error=False,what_if=preview,timeout_seconds=60)
        steps=[{'phase':'disable','args':self.first.admin_args},{'phase':'enable','args':self.second.admin_args}]
        with patch.object(runner,'load_control',return_value=control), patch('sys.stdout',new_callable=io.StringIO):
            return runner.run_shared(args,steps,path)

    def test_runner_preview_can_be_followed_by_apply_and_records_final_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'batch.jsonl'
            self.assertEqual(self.run_runner(path,preview=True),0)
            self.assertFalse(path.exists())
            self.assertEqual(self.run_runner(path),0)
            events=[json.loads(line)['event'] for line in path.read_text().splitlines()]
            self.assertEqual(events,['batch_start','backup_verified','step_started','step_committed',
                                     'step_started','step_committed','batch_verified'])
            with self.assertRaisesRegex(ValueError,'Existing batch log'):
                self.run_runner(path)
            self.assertEqual(self.mocks['create_target_backup'].call_count,1)

    def test_runner_records_uncertain_failure_and_does_not_execute_next_step(self):
        self.mocks['run_remote_admin'].side_effect=RuntimeError('connection lost after submission')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'batch.jsonl'
            with self.assertRaisesRegex(RuntimeError,'connection lost'):
                self.run_runner(path)
            events=[json.loads(line)['event'] for line in path.read_text().splitlines()]
            self.assertEqual(events,['batch_start','backup_verified','step_started','batch_failed'])
            self.assertEqual(self.mocks['run_remote_admin'].call_count,1)

    def test_runner_final_check_failure_cannot_record_verified(self):
        self.mocks['run_helper_json'].side_effect=[HEALTH,{'integrity':{'quick_check':'bad'}}]
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'batch.jsonl'
            with self.assertRaises(control.ManagementError):
                self.run_runner(path)
            events=[json.loads(line)['event'] for line in path.read_text().splitlines()]
            self.assertNotIn('batch_verified',events)
            self.assertEqual(events[-1],'batch_failed')


if __name__=='__main__':
    unittest.main()
