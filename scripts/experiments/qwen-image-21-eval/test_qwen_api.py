"""HTTP safety checks without loading the model or allocating GPU memory."""
import os
os.environ['QWEN_IMAGE_API_KEY']='unit-test-key-with-at-least-32-characters'
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import qwen_eval_api as api


class ApiContract(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(api.app)
        self.body={'prompt':'Three cups','model':'qwen-image-2.1'}
        self.headers={'Authorization':'Bearer '+api.api_key}

    def test_authentication_fails_closed_before_generation(self):
        for headers in ({},{'Authorization':'Bearer wrong'}):
            self.assertEqual(self.client.post('/v1/images/generations',json=self.body,headers=headers).status_code,401)

    def test_valid_auth_does_not_bypass_readiness(self):
        with patch.object(api,'state','loading'):
            self.assertEqual(self.client.post('/v1/images/generations',json=self.body,headers=self.headers).status_code,503)

    def test_parameters_and_concurrency(self):
        with patch.object(api,'state','ready'):
            for extra in ({'size':'999x1024'},{'model':'unknown'},{'response_format':'url'}):
                self.assertEqual(self.client.post('/v1/images/generations',json={**self.body,**extra},headers=self.headers).status_code,400)
            api.lock.acquire()
            try:
                self.assertEqual(self.client.post('/v1/images/generations',json=self.body,headers=self.headers).status_code,429)
            finally:
                api.lock.release()
            with patch.object(api,'gpu_stats',return_value={'temperature_c':61,'memory_free_mib':39000}):
                self.assertEqual(self.client.post('/v1/images/generations',json=self.body,headers=self.headers).status_code,503)


if __name__=='__main__':
    unittest.main()
