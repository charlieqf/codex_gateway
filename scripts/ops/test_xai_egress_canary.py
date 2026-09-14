import copy
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('canary', pathlib.Path(__file__).with_name('xai-egress-canary-r760.py'))
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)

class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.nodes = dict(canary.NODES)
        canary.NODES['b'] = canary.node_id('synthetic-primary')
        canary.NODES['c'] = canary.node_id('synthetic-backup')
        self.original = {'mode': 'rule', 'port': 7890, 'dns': {'enable': True},
            'proxies': [{'name': 'synthetic-primary', 'type': 'http', 'server': '127.0.0.1', 'port': 8101},
                        {'name': 'synthetic-backup', 'type': 'http', 'server': '127.0.0.1', 'port': 8102}],
            'proxy-groups': [{'name': 'existing', 'type': 'select', 'proxies': ['synthetic-primary']}],
            'rules': ['DOMAIN,domestic.example,DIRECT', 'MATCH,existing']}
    def tearDown(self):
        canary.NODES.clear()
        canary.NODES.update(self.nodes)
    def test_only_xai_rule_and_group_are_added(self):
        before = copy.deepcopy(self.original)
        result = canary.candidate(self.original)
        self.assertEqual(self.original, before)
        self.assertEqual(result['rules'][0], 'DOMAIN,api.x.ai,XAI-EGRESS')
        self.assertEqual(result['rules'][1:], before['rules'])
        self.assertEqual(result['proxy-groups'][:-1], before['proxy-groups'])
        self.assertEqual({k: v for k, v in result.items() if k not in ('rules', 'proxy-groups')},
                         {k: v for k, v in before.items() if k not in ('rules', 'proxy-groups')})
        group = result['proxy-groups'][-1]
        self.assertEqual(group['proxies'], ['synthetic-primary', 'synthetic-backup'])
        self.assertEqual(group['expected-status'], 401)
        self.assertFalse(group['lazy'])
    def test_no_synthetic_failure_in_production_candidate(self):
        self.assertNotIn('XAI-FAULT-TEST-ONLY', str(canary.candidate(self.original)))
    def test_fault_injection_retains_real_backup(self):
        result = canary.candidate(self.original, 'failover')
        self.assertEqual(result['proxy-groups'][-1]['proxies'], ['XAI-FAULT-TEST-ONLY', 'synthetic-backup'])
        self.assertEqual(result['proxies'][-1]['server'], '127.0.0.1')
    def test_existing_group_rejected(self):
        self.original['proxy-groups'].append({'name': 'XAI-EGRESS'})
        with self.assertRaises(ValueError): canary.candidate(self.original)
    def test_missing_leaf_fails_closed(self):
        self.original['proxies'].pop()
        with self.assertRaises(StopIteration): canary.candidate(self.original)
    def test_container_scope(self):
        with self.assertRaises(ValueError): canary.container('../production')

if __name__ == '__main__': unittest.main()
