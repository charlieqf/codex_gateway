"""Exercise worker cleanup/order with a fake Torch module and no model weights."""
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from PIL import Image
import qwen_eval_api as api


class ScheduledWorker(unittest.TestCase):
    def test_missing_ticket_rejected_without_model_import(self):
        with patch.object(api,'scheduled',True),patch.object(api,'state','ready'):
            response=TestClient(api.app).post('/v1/images/generations',json={'prompt':'synthetic'},headers={'Authorization':'Bearer '+api.api_key})
            self.assertEqual(response.status_code,503)

    def test_mock_inference_runs_only_after_claim_and_cleanup_precedes_release(self):
        self.run_fake(False)

    def test_mock_cleanup_failure_quarantines_worker_and_requests_exit(self):
        self.run_fake(True)

    def run_fake(self, cleanup_error):
        events=[]
        class FakeLease:
            def __init__(self,*args,**kwargs): pass
            def acquire(self): events.append('claim'); return self
            def check(self): pass
            def finish(self,*args,**kwargs): events.append(('release',kwargs.get('cleanup_ok')))
        def cleanup():
            events.append('cleanup')
            if cleanup_error: raise RuntimeError('synthetic cleanup failure')
        picture=Image.new('RGB',(32,32),'white')
        picture.paste('black',(0,0,16,16))
        class FakePipeline:
            def __call__(self,**kwargs):
                self.assert_claimed()
                events.append('inference')
                return SimpleNamespace(images=[picture])
            def assert_claimed(self):
                if events!=['claim']: raise AssertionError(events)
            maybe_free_model_hooks=staticmethod(cleanup)
        cuda=Mock()
        cuda.max_memory_allocated.return_value=cuda.max_memory_reserved.return_value=0
        torch=SimpleNamespace(cuda=cuda,Generator=lambda *_:SimpleNamespace(manual_seed=lambda seed:None))
        stats={'temperature_c':40,'memory_free_mib':40000,'memory_used_mib':1}
        with patch.object(api,'scheduled',True),patch.object(api,'state','ready'),patch.object(api,'load_error',None),patch.object(api,'pipeline',FakePipeline()),patch.object(api,'gpu_stats',return_value=stats),patch.dict(sys.modules,{'torch':torch}),patch('star_gpu_scheduler.client.Lease',FakeLease),patch('star_gpu_scheduler.client.Client.from_env',return_value=Mock()),patch.object(api.os,'_exit') as hard_stop:
            ticket={'grant':{'executor':'qwen_worker_'+str(api.GPU_ID)}}
            response=TestClient(api.app).post('/v1/images/generations',json={'prompt':'synthetic'},headers={'Authorization':'Bearer '+api.api_key,'X-Scheduler-Ticket':json.dumps(ticket)})
            self.assertEqual(response.status_code,503 if cleanup_error else 200)
            self.assertEqual(events,['claim','inference','cleanup',('release',not cleanup_error)])
            self.assertEqual(hard_stop.call_count,1 if cleanup_error else 0)
            self.assertFalse(api.lock.locked())


if __name__=='__main__': unittest.main()
