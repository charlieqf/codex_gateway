import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS=Path(__file__).resolve().parents[1]/'scripts'
sys.path.insert(0,str(SCRIPTS))
spec=importlib.util.spec_from_file_location('unified_expiry_control',SCRIPTS/'manage-r760-gateway-control.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class UnifiedExpiryControlTests(unittest.TestCase):
    def test_preview_backup_write_order_and_plan_is_not_reread(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'plan.json'
            plan={'version':1,'reason':'authorized','items':[{'keyId':'key-1'}]}
            path.write_text(json.dumps(plan),encoding='utf-8')
            args=module.parse_args(['--',module.UNIFIED_KEY_EXPIRY_COMMAND,str(path)])
            order=[]
            def operation(_endpoint,_args,value,*,apply):
                order.append('write' if apply else 'preview')
                self.assertEqual(value,plan)
                path.write_text('{}',encoding='utf-8')
                return {'applied':apply,'count':1}
            with (mock.patch.object(module,'run_unified_key_expiry',side_effect=operation),
                  mock.patch.object(module,'install_helper'),
                  mock.patch.object(module,'remove_helper_best_effort'),
                  mock.patch.object(module,'run_helper_json',return_value={'migration':30,'integrity':{'quick_check':'ok','foreign_key_violations':0}}),
                  mock.patch.object(module,'create_target_backup',side_effect=lambda *a,**kw:order.append('backup') or {}),
                  mock.patch.object(module,'run_remote_admin') as admin):
                result=module.execute(args)
                self.assertTrue(result['authority_result']['applied'])
                self.assertEqual(order,['preview','backup','write'])
                admin.assert_not_called()

    def test_what_if_does_not_install_or_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'plan.json';path.write_text('{}',encoding='utf-8')
            args=module.parse_args(['--what-if','--',module.UNIFIED_KEY_EXPIRY_COMMAND,str(path)])
            with (mock.patch.object(module,'run_unified_key_expiry',return_value={'applied':False}) as operation,
                  mock.patch.object(module,'install_helper') as install,
                  mock.patch.object(module,'create_target_backup') as backup):
                self.assertTrue(module.execute(args)['what_if'])
                operation.assert_called_once();self.assertFalse(operation.call_args.kwargs['apply'])
                install.assert_not_called();backup.assert_not_called()

    def test_rejects_unsupported_argument_shapes(self):
        for args in ([module.UNIFIED_KEY_EXPIRY_COMMAND],[module.UNIFIED_KEY_EXPIRY_COMMAND,'x','extra']):
            with self.assertRaises(module.ManagementError):module.validate_admin_args(args)

if __name__=='__main__':unittest.main()
