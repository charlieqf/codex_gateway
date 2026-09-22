"""Versioned, content-free private scheduler protocol."""
import hashlib
import json
import math
import re

GPU0 = 'GPU-9df0d9aa-0e98-59af-1de3-0d1ff8564c98'
GPU1 = 'GPU-b78f29ae-cd33-3c2c-9609-b898f1142c50'
GPUS = (GPU0, GPU1)
TERMINAL = frozenset(('succeeded', 'failed', 'cancelled', 'expired'))
ROLES = frozenset(('qwen_pool', 'qwen_worker_0', 'qwen_worker_1', 'radar_service', 'radar_runner', 'operator'))
PROFILES = {
    'image': 'qwen_bf16_offload_v1',
    'image_init': 'qwen_initialize_v1',
    'ct_infer': 'radar_abdominal_v1',
    'ct_preprocess': 'radar_preprocess_v1',
}
ERRORS = frozenset(('execution_failed', 'resource_unavailable', 'cancelled', 'deadline',
    'worker_restarted', 'cleanup_failed', 'grant_delivery_failed', 'producer_lost'))


class Rejected(Exception):
    def __init__(self, code, status=409):
        self.code, self.status = code, status
        super().__init__(code)


def require(ok, code='invalid_request', status=400):
    if not ok:
        raise Rejected(code, status)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def token_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value) is not None


def register_body(role, body, now):
    require(isinstance(body, dict))
    common = {'schema_version', 'producer_instance', 'operation_id', 'kind', 'profile', 'payload_sha256'}
    kind = body.get('kind')
    require(kind in PROFILES and body.get('profile') == PROFILES[kind])
    extra = {'queue_timeout_ms', 'request_budget_ms', 'request_ref'} if kind in ('image', 'image_init') else {'expires_at'}
    require(not set(body)-(common | extra) and common <= set(body))
    require(body['schema_version'] == 1 and type(body['schema_version']) is int)
    require(all(identifier(body[k]) for k in ('producer_instance', 'operation_id')))
    require(isinstance(body['payload_sha256'], str) and re.fullmatch('[0-9a-f]{64}', body['payload_sha256']))
    allowed = {'qwen_pool': ('image',), 'radar_service': ('ct_infer', 'ct_preprocess'),
               'qwen_worker_0': ('image_init',), 'qwen_worker_1': ('image_init',)}
    require(kind in allowed.get(role, ()), 'unauthorized', 401)
    if kind in ('image', 'image_init'):
        maximum = 80000 if kind == 'image' else 300000
        budget = 170000 if kind == 'image' else 480000
        for name, limit in [('queue_timeout_ms', maximum), ('request_budget_ms', budget)]:
            require(type(body.get(name)) is int and 0 < body[name] <= limit)
        require(body['queue_timeout_ms'] <= body['request_budget_ms'])
        require('request_ref' not in body or identifier(body['request_ref']))
    else:
        expires = body.get('expires_at')
        require(type(expires) in (int, float) and math.isfinite(expires) and now < expires <= now+86400)
    return kind
