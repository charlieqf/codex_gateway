"""Account-operation routing regressions; no production access."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('manage-r760-gateway-control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class AccountRoutingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'manifest.json'
        self.manifest = {'version':1,'operationId':'routing-test','reason':'Approved renewal',
            'items':[{'subjectId':'s1','entitlementId':'e1','expiresAt':'2028-03-10T02:19:34.469Z'}]}
        self.path.write_text(json.dumps(self.manifest), encoding='utf-8')
        for name in ('create_target_backup','install_helper','run_helper_json','run_remote_admin'):
            p = patch.object(control,name,side_effect=AssertionError('Routine renewal reached full-backup/maintenance path'))
            p.start(); self.addCleanup(p.stop)

    def args(self,preview=False,revision=True,command='renew-accounts'):
        return control.parse_args([*(['--what-if'] if preview else []),'--',command,str(self.path),*(['a'*64] if revision else [])])

    def response(self,kind='renew',apply=True):
        return SimpleNamespace(stdout=json.dumps({'operation_id':'routing-test','kind':kind,'count':1,
            'revision':'a'*64,'applied':apply,'protection':'transaction_and_scoped_journal'}))

    def test_preview_and_apply_bypass_backup_and_full_integrity_scan(self):
        for preview in (True,False):
            with self.subTest(preview=preview), patch.object(control,'run_ssh',return_value=self.response(apply=not preview)) as remote:
                result=control.execute(self.args(preview))
                self.assertEqual(result['protection'],'transaction_and_scoped_journal')
                self.assertEqual(result['what_if'],preview)
                self.assertEqual(remote.call_count,1)
                script=remote.call_args.kwargs['stdin']
                self.assertIn('globalThis.R760_ACCOUNT_OPERATION=',script)
                self.assertNotIn('routing-test',remote.call_args.args[1])
                self.assertIn('"apply": '+('false' if preview else 'true'),script)

    def test_undo_uses_the_same_scoped_route(self):
        self.path.write_text(json.dumps({'version':1,'operationId':'routing-test','renewalOperationId':'original',
            'reason':'Undo reviewed mistake','subjectIds':['s1']}),encoding='utf-8')
        with patch.object(control,'run_ssh',return_value=self.response(kind='undo')):
            self.assertEqual(control.execute(self.args(command='undo-account-renewal'))['authority_result']['kind'],'undo')

    def test_apply_requires_review_revision_before_any_remote_call(self):
        with patch.object(control,'run_ssh') as remote, self.assertRaisesRegex(control.ManagementError,'revision'):
            control.execute(self.args(revision=False))
        remote.assert_not_called()

    def test_manifest_cannot_override_execution_controls(self):
        for key,value in [('apply',True),('kind','undo'),('expectedRevision','b'*64)]:
            self.path.write_text(json.dumps({**self.manifest,key:value}),encoding='utf-8')
            with self.subTest(field=key), patch.object(control,'run_ssh') as remote, self.assertRaisesRegex(control.ManagementError,'execution-control'):
                control.execute(self.args(preview=True))
            remote.assert_not_called()

    def test_transport_failure_propagates_without_fallback_or_retry(self):
        with patch.object(control,'run_ssh',side_effect=RuntimeError('Response lost after commit')) as remote:
            with self.assertRaisesRegex(RuntimeError,'Response lost'):
                control.execute(self.args())
            self.assertEqual(remote.call_count,1)

    def test_cannot_mix_atomic_account_operation_into_legacy_shared_context(self):
        with self.assertRaises(control.ManagementError):
            control.VerifiedControlBatch(self.args(),[self.args().admin_args])
        with self.assertRaisesRegex(control.ManagementError,'already one atomic batch'):
            control.execute(self.args(),batch=object())

    def test_wrong_receipt_cannot_report_success(self):
        with patch.object(control,'run_ssh',return_value=self.response(kind='undo')), self.assertRaisesRegex(control.ManagementError,'Unexpected'):
            control.execute(self.args())


if __name__ == '__main__':
    unittest.main()
