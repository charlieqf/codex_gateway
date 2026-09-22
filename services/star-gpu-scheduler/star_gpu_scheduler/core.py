"""Single-host durable scheduling. No model imports or execution payloads."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from uuid import uuid4

from .protocol import GPUS, GPU0, GPU1, TERMINAL, ERRORS, Rejected, canonical, digest, register_body, require, token_hash
from .runtime import same_process


class Scheduler:
    def __init__(self, path, runtime, *, clock=time.time, mode='enforce', reserve_mib=12288):
        self.runtime, self.clock, self.mode, self.reserve_mib = runtime, clock, mode, reserve_mib
        self.lock = threading.RLock()
        self.tokens = {}
        self.ready = False
        self.failed = False
        self.last_time = clock()
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.executescript('''
            PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE NOT NULL,role TEXT NOT NULL,operation TEXT NOT NULL,
                fingerprint TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(role,operation));
            CREATE TABLE IF NOT EXISTS slots(gpu TEXT PRIMARY KEY,generation INTEGER NOT NULL,
                task_id TEXT UNIQUE REFERENCES tasks(id));
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                at REAL NOT NULL,task_id TEXT,state TEXT NOT NULL,reason TEXT);
        ''')
        version = self.db.execute("SELECT value FROM meta WHERE key='version'").fetchone()
        require(version is None or version[0] == '1', 'unsupported_schema')
        self.db.execute("INSERT OR IGNORE INTO meta VALUES ('version','1')")
        self.db.execute("INSERT OR IGNORE INTO meta VALUES ('drain','all')")
        for gpu in GPUS:
            self.db.execute('INSERT OR IGNORE INTO slots VALUES (?,0,NULL)', (gpu,))

    @contextmanager
    def transaction(self):
        with self.lock:
            try:
                self.db.execute('BEGIN IMMEDIATE')
                yield
                self.db.commit()
            except sqlite3.Error as exc:
                self.failed = True
                self.ready = False
                self.db.rollback()
                raise Rejected('storage_unavailable', 503) from exc
            except BaseException:
                self.db.rollback()
                raise

    def close(self):
        self.db.close()

    def tasks(self):
        return [json.loads(row[0]) for row in self.db.execute('SELECT payload FROM tasks ORDER BY sequence')]

    def task(self, task_id):
        row = self.db.execute('SELECT payload FROM tasks WHERE id=?', (task_id,)).fetchone()
        require(row is not None, 'not_found', 404)
        return json.loads(row[0])

    def save(self, task, state=None, reason=None):
        old = task['state']
        if state is not None:
            task['state'] = state
        task['updated_at'] = self.clock()
        if reason is not None:
            task['wait_reason'] = reason
        self.db.execute('UPDATE tasks SET payload=? WHERE id=?', (canonical(task), task['id']))
        if old != task['state'] or reason is not None:
            self.db.execute('INSERT INTO events(at,task_id,state,reason) VALUES (?,?,?,?)',
                (self.clock(), task['id'], task['state'], reason))

    def visible(self, task, role):
        result = {k: task.get(k) for k in ('id', 'state', 'wait_reason', 'kind', 'generation', 'gpu', 'outcome', 'error_code')}
        result['task_id'] = result.pop('id')
        result['schema_version'] = 1
        result['cancel_requested'] = task['cancel_requested']
        result['execution_deadline'] = task.get('execution_deadline')
        if task['state'] == 'granted' and task['id'] in self.tokens and role in (task['role'], task.get('executor')):
            result['grant'] = {'executor': task['executor'], 'gpu_uuid': task['gpu'],
                'generation': task['generation'], 'token': self.tokens[task['id']],
                'claim_within_ms': max(0, int((task['claim_deadline']-self.clock())*1000))}
        return result

    def register(self, role, body, peer):
        now = self.clock()
        kind = register_body(role, body, now)
        require(self.runtime.executor_allowed(role, peer), 'unauthorized', 401)
        fingerprint = digest({k: v for k, v in body.items() if k != 'producer_instance'})
        with self.transaction():
            row = self.db.execute('SELECT payload,fingerprint FROM tasks WHERE role=? AND operation=?',
                (role, body['operation_id'])).fetchone()
            if row:
                task = json.loads(row[0])
                require(row[1] == fingerprint, 'idempotency_conflict')
                if task['producer_instance'] != body['producer_instance']:
                    require(kind.startswith('ct_') and not task.get('execution') and
                        task['state'] == 'queued' and self.runtime.alive(task['producer']) is False, 'invalid_transition')
                    task.update(producer_instance=body['producer_instance'], producer=peer)
                task['producer_heartbeat'] = now
                self.save(task)
                return 200, self.visible(task, role)
            active = [t for t in self.tasks() if t['state'] not in TERMINAL]
            capacity = 4 if kind == 'image' else 1 if kind == 'image_init' else 32
            count = sum((t['kind'] == kind and (kind != 'image_init' or t['role'] == role))
                if kind in ('image', 'image_init') else t['kind'].startswith('ct_') for t in active)
            require(count < capacity, 'queue_full', 429)
            deadline = now+body['queue_timeout_ms']/1000 if 'queue_timeout_ms' in body else body['expires_at']
            request_deadline = now+body['request_budget_ms']/1000 if 'request_budget_ms' in body else body['expires_at']
            task = {'id': 'sched_'+uuid4().hex, 'role': role, 'operation_id': body['operation_id'],
                'producer_instance': body['producer_instance'], 'producer': peer, 'producer_heartbeat': now,
                'kind': kind, 'profile': body['profile'], 'payload_sha256': body['payload_sha256'],
                'state': 'queued', 'wait_reason': None, 'created_at': now, 'updated_at': now,
                'queue_deadline': deadline, 'request_deadline': request_deadline, 'generation': 0,
                'gpu': None, 'executor': None, 'execution': None, 'grant_attempts': 0,
                'cancel_requested': False, 'outcome': None, 'error_code': None}
            self.db.execute('INSERT INTO tasks(id,role,operation,fingerprint,payload) VALUES (?,?,?,?,?)',
                (task['id'], role, body['operation_id'], fingerprint, canonical(task)))
            self.save(task, reason='queued')
            return 201, self.visible(task, role)

    def authorize(self, task, role):
        require(role in (task['role'], task.get('executor'), 'operator') or
            (role == 'radar_service' and task['kind'].startswith('ct_')), 'not_found', 404)

    def get(self, task_id, role):
        with self.lock:
            task = self.task(task_id)
            self.authorize(task, role)
            return self.visible(task, role)

    def command(self, task_id, action, role, body, peer):
        fields = {'producer-heartbeat': {'producer_instance'},
            'claim': {'generation', 'grant_token', 'payload_sha256', 'unit', 'invocation_id'},
            'heartbeat': {'generation', 'grant_token', 'phase'},
            'finish': {'generation', 'grant_token', 'outcome', 'error_code'},
            'released': {'generation', 'grant_token'}, 'cancel': {'producer_instance', 'reason'}}
        require(action in fields and isinstance(body, dict) and set(body) == fields[action])
        now = self.clock()
        with self.transaction():
            task = self.task(task_id)
            self.authorize(task, role)
            if action in ('producer-heartbeat', 'cancel'):
                require(role == task['role'] and body['producer_instance'] == task['producer_instance'] and
                    same_process(peer, task['producer']), 'unauthorized', 401)
                if action == 'producer-heartbeat':
                    task['producer_heartbeat'] = now
                else:
                    require(body['reason'] in ('client_disconnected', 'deadline', 'explicit_cancel',
                        'resource_deleted', 'producer_shutdown'))
                    if task['state'] not in TERMINAL:
                        task['cancel_requested'] = True
                        if task['state'] == 'queued':
                            self.terminal(task, 'cancelled')
                        elif task['state'] == 'granted':
                            self.save(task, 'recovering', 'cancel_requested')
                self.save(task)
                return self.visible(task, role)
            require(type(body['generation']) is int and body['generation'] == task['generation'] and
                isinstance(body['grant_token'], str) and
                secrets.compare_digest(token_hash(body['grant_token']), task.get('token_hash', '')), 'stale_grant')
            supervisor = action == 'released' and role == 'radar_service' and same_process(peer, task['producer'])
            require(supervisor or (role == task['executor'] and self.runtime.executor_allowed(role, peer)), 'unauthorized', 401)
            if action == 'claim':
                require(body['payload_sha256'] == task['payload_sha256'] and body['unit'] == peer['unit'] and
                    body['invocation_id'] == peer['invocation_id'], 'stale_grant')
                if task.get('execution'):
                    require(same_process(task['execution'], peer) and task['state'] == 'running', 'invalid_transition')
                    return self.visible(task, role)
                require(task['state'] == 'granted' and not task['cancel_requested'] and
                    now < min(task['claim_deadline'], task['queue_deadline'], task['request_deadline']), 'stale_grant')
                # The client must already own the real lock. A free lock cannot be claimed.
                require(task['gpu'] is None or self.runtime.owns_lock(task['gpu'], peer['pid']), 'lock_not_held')
                task['execution'] = peer
                task['heartbeat'] = now
                duration = 900 if task['kind'].startswith('ct_') else 480 if task['kind'] == 'image_init' else 180
                task['execution_deadline'] = min(task['request_deadline'], now+duration)
                self.save(task, 'running')
            else:
                require(task.get('execution') and (supervisor or same_process(task['execution'], peer)), 'invalid_transition')
                if action == 'heartbeat':
                    require(body['phase'] in ('initializing', 'inference', 'cleanup'))
                    if task['state'] not in TERMINAL:
                        task['heartbeat'] = now
                        task['phase'] = body['phase']
                        if task['state'] == 'recovering' and task.get('outcome') is None:
                            self.save(task, 'running')
                elif action == 'finish':
                    require(body['outcome'] in ('succeeded', 'failed', 'cancelled') and
                        (body['error_code'] is None or body['error_code'] in ERRORS))
                    if task['outcome'] is not None:
                        require((task['outcome'], task['error_code']) == (body['outcome'], body['error_code']), 'invalid_transition')
                    else:
                        require(task['state'] in ('running', 'recovering'), 'invalid_transition')
                        task.update(outcome=body['outcome'], error_code=body['error_code'])
                        self.save(task, 'releasing')
                elif action == 'released':
                    self.reconcile(task, now)
                self.save(task)
            return self.visible(task, role)

    def terminal(self, task, outcome):
        self.db.execute('UPDATE slots SET task_id=NULL WHERE task_id=?', (task['id'],))
        self.tokens.pop(task['id'], None)
        self.save(task, outcome)

    def reconcile(self, task, now):
        if task['state'] in TERMINAL or task['state'] == 'queued':
            return
        lock_free = task['gpu'] is None or self.runtime.lock_free(task['gpu'])
        execution = task.get('execution')
        if not execution:
            if now >= task.get('claim_deadline', 0) or task['cancel_requested'] or task['state'] == 'recovering' or task['id'] not in self.tokens:
                if lock_free:
                    self.db.execute('UPDATE slots SET task_id=NULL WHERE task_id=?', (task['id'],))
                    self.tokens.pop(task['id'], None)
                    if task['cancel_requested']:
                        self.terminal(task, 'cancelled')
                    elif now >= task['queue_deadline']:
                        self.terminal(task, 'expired')
                    elif task['grant_attempts'] >= 2:
                        task['error_code'] = 'grant_delivery_failed'
                        self.terminal(task, 'failed')
                    else:
                        self.save(task, 'queued', 'grant_recovered')
                else:
                    self.save(task, 'recovering', 'lock_held')
            return
        alive = self.runtime.alive(execution)
        proof = alive is False or (task['kind'] in ('image', 'image_init') and self.runtime.receipt(execution, task))
        if lock_free and proof:
            task['error_code'] = task['error_code'] or (None if task['outcome'] else 'worker_restarted')
            self.terminal(task, task['outcome'] or 'failed')
        elif now-task.get('heartbeat', 0) > 10:
            self.save(task, 'recovering', 'executor_unconfirmed')

    def growth(self, task, snapshot):
        if task['kind'].startswith('ct_'):
            # Keeping the full bound after start is conservative and avoids sampling transient units.
            return 32768
        return max(0, 57344-snapshot['cgroups'].get(task['executor'], {}).get('current_mib', 0))

    def reserve(self, task, gpu, snapshot, tasks, protect_ct=None):
        now = self.clock()
        if now-task['producer_heartbeat'] > 10 or task['cancel_requested'] or now >= task['queue_deadline']:
            return False
        if gpu is not None:
            slot = self.db.execute('SELECT generation,task_id FROM slots WHERE gpu=?', (gpu,)).fetchone()
            if slot[1] or not self.runtime.lock_free(gpu):
                return False
            task['executor'] = 'radar_runner' if task['kind'] == 'ct_infer' else 'qwen_worker_'+str(GPUS.index(gpu))
        else:
            task['executor'] = 'radar_runner'
        if task['kind'].startswith('ct_') and any(t['id'] != task['id'] and t['kind'].startswith('ct_') and t['state'] in ('granted', 'running', 'releasing', 'recovering') for t in tasks):
            return False
        if gpu is not None:
            stats = snapshot['gpus'][gpu]
            if stats['temperature'] > 80 or stats['free_mib'] < (32768 if task['kind'] == 'ct_infer' else 30000):
                task['wait_reason'] = 'waiting_gpu'
                self.save(task)
                return False
            for process in stats.get('processes', []):
                known = any(same_process(process, t['execution']) for t in tasks if t.get('execution'))
                known = known or any(same_process(process, c['identity']) for c in snapshot['cgroups'].values() if c.get('identity'))
                known = known or process['unit'] == self.runtime.units.get('indextts')
                if not known:
                    task['wait_reason'] = 'unmanaged_gpu_process'
                    self.save(task)
                    return False
        active = [t for t in tasks if t['state'] in ('granted', 'running', 'releasing', 'recovering')]
        protected = 32768 if protect_ct and protect_ct['id'] != task['id'] and not any(t['kind'] == 'ct_infer' for t in active) else 0
        remaining = snapshot['memory_available_mib']-sum(self.growth(t, snapshot) for t in active)-self.growth(task, snapshot)-protected
        if remaining < self.reserve_mib:
            task['wait_reason'] = 'waiting_memory'
            self.save(task)
            return False
        task.update(gpu=gpu, generation=(slot[0]+1 if gpu else task['generation']+1),
            claim_deadline=min(now+15, task['queue_deadline']), grant_attempts=task['grant_attempts']+1,
            wait_reason=None)
        token = secrets.token_urlsafe(32)
        task['token_hash'] = token_hash(token)
        self.tokens[task['id']] = token
        self.save(task, 'granted')
        if gpu:
            self.db.execute('UPDATE slots SET generation=?,task_id=? WHERE gpu=?', (task['generation'], task['id'], gpu))
        return True

    def tick(self):
        snapshot = self.runtime.observe()
        now = self.clock()
        with self.transaction():
            if now < self.last_time-1 or self.failed:
                self.ready = False
                self.db.execute("UPDATE meta SET value='all' WHERE key='drain'")
                return
            self.last_time = now
            # Bound metadata without deleting any live task or its slot reference.
            cutoff = now-30*86400
            self.db.execute("DELETE FROM tasks WHERE json_extract(payload,'$.state') IN ('succeeded','failed','cancelled','expired') AND json_extract(payload,'$.updated_at') < ?", (cutoff,))
            self.db.execute('DELETE FROM events WHERE at < ?', (cutoff,))
            tasks = self.tasks()
            for task in tasks:
                if task['state'] in TERMINAL:
                    continue
                if task['state'] == 'queued':
                    if now >= task['queue_deadline']:
                        self.terminal(task, 'expired')
                    elif now-task['producer_heartbeat'] > 10 and not task['kind'].startswith('ct_'):
                        task['error_code'] = 'producer_lost'
                        self.terminal(task, 'cancelled')
                else:
                    if now-task['producer_heartbeat'] > 10 and not task.get('execution'):
                        if not task['kind'].startswith('ct_'):
                            task['cancel_requested'] = True
                        task['state'] = 'recovering'
                    self.reconcile(task, now)
            self.ready = bool(snapshot['ok'] and time.monotonic()-snapshot['mono'] <= 2)
            if not self.ready or self.mode != 'enforce':
                return
            drain = self.db.execute("SELECT value FROM meta WHERE key='drain'").fetchone()[0]
            if drain == 'all':
                return
            tasks = self.tasks()
            queued = [t for t in tasks if t['state'] == 'queued' and now-t['producer_heartbeat'] <= 10]
            ct = next((t for t in queued if t['kind'] == 'ct_infer'), None)
            if ct and drain != GPU1:
                self.reserve(ct, GPU1, snapshot, tasks)
            preprocess = next((t for t in queued if t['kind'] == 'ct_preprocess'), None)
            if preprocess and not ct:
                self.reserve(preprocess, None, snapshot, tasks)
            for index, gpu in enumerate(GPUS):
                if drain == gpu or (gpu == GPU1 and ct):
                    continue
                init = next((t for t in queued if t['kind'] == 'image_init' and t['role'] == 'qwen_worker_'+str(index)), None)
                if init:
                    self.reserve(init, gpu, snapshot, tasks, ct)
                elif snapshot['cgroups'].get('qwen_worker_'+str(index), {}).get('ready', True):
                    image = next((t for t in queued if t['kind'] == 'image' and t['state'] == 'queued'), None)
                    if image:
                        self.reserve(image, gpu, snapshot, tasks, ct)

    def admin(self, action, body):
        require(set(body) == {'scope', 'gpu_uuid', 'reason_code'} and body['scope'] in ('all', 'gpu') and
            body['reason_code'] in ('maintenance', 'verification', 'recovery'))
        require(body['gpu_uuid'] in GPUS if body['scope'] == 'gpu' else body['gpu_uuid'] is None)
        with self.transaction():
            current = self.db.execute("SELECT value FROM meta WHERE key='drain'").fetchone()[0]
            if action == 'resume':
                require(self.ready and not self.failed, 'scheduler_unavailable', 503)
                if body['scope'] == 'all':
                    value = ''
                elif current == 'all':
                    value = next(gpu for gpu in GPUS if gpu != body['gpu_uuid'])
                else:
                    value = '' if current == body['gpu_uuid'] else current
            else:
                value = 'all' if body['scope'] == 'all' or current not in ('', body['gpu_uuid']) else body['gpu_uuid']
            self.db.execute("UPDATE meta SET value=? WHERE key='drain'", (value,))
        return self.status()

    def status(self):
        with self.lock:
            tasks = self.tasks()
            return {'schema_version': 1, 'ready': self.ready and not self.failed, 'mode': self.mode,
                'drain': self.db.execute("SELECT value FROM meta WHERE key='drain'").fetchone()[0],
                'counts': {state: sum(t['state'] == state for t in tasks) for state in ('queued', 'granted', 'running', 'releasing', 'recovering')},
                'tasks': [self.visible(t, 'operator') for t in tasks if t['state'] not in TERMINAL][:16]}
