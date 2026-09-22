"""Standard-library adapters. A running executor, never the broker, owns flock."""
from contextlib import contextmanager
import http.client
import json
import os
import re
from pathlib import Path
import socket
import threading
import time
from uuid import uuid4

from .protocol import PROFILES, TERMINAL, Rejected, canonical, digest, require
from .runtime import GpuLock, identity


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=2)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Client:
    def __init__(self, path, token, *, instance=None):
        self.path, self.token = str(path), token
        self.instance = instance or 'producer-'+uuid4().hex

    @classmethod
    def from_env(cls, role):
        path = os.environ.get('GPU_SCHEDULER_SOCKET')
        if not path and os.environ.get('GPU_SCHEDULER_REQUIRED') != '1':
            return None
        require(bool(path), 'scheduler_configuration', 503)
        key_path = os.environ.get('GPU_SCHEDULER_'+role.upper()+'_TOKEN_FILE') or os.environ.get('GPU_SCHEDULER_TOKEN_FILE')
        require(bool(key_path), 'scheduler_configuration', 503)
        key = Path(key_path).read_text().strip()
        require(len(key) >= 32, 'scheduler_configuration', 503)
        return cls(path, key)

    def rpc(self, method, route, body=None):
        connection = UnixConnection(self.path)
        try:
            data = canonical(body).encode() if body is not None else None
            connection.request(method, route, data, {'Authorization': 'Bearer '+self.token,
                'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(16385)
            require(len(raw) <= 16384, 'scheduler_protocol', 503)
            value = json.loads(raw)
            if response.status >= 400:
                raise Rejected(value.get('error', {}).get('code', 'scheduler_unavailable'), response.status)
            return value
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise Rejected('scheduler_unavailable', 503) from exc
        finally:
            connection.close()

    def register(self, kind, operation, payload, *, queue_ms=80000, budget_ms=170000, expires_at=None):
        body = {'schema_version': 1, 'producer_instance': self.instance, 'operation_id': operation,
            'kind': kind, 'profile': PROFILES[kind], 'payload_sha256': digest(payload)}
        if expires_at is None:
            body.update(queue_timeout_ms=queue_ms, request_budget_ms=budget_ms)
        else:
            body['expires_at'] = expires_at
        return self.rpc('POST', '/v1/tasks', body)

    def get(self, task):
        return self.rpc('GET', '/v1/tasks/'+task)

    def command(self, task, action, body):
        return self.rpc('POST', '/v1/tasks/'+task+'/'+action, body)

    def producer_heartbeat(self, task):
        return self.command(task, 'producer-heartbeat', {'producer_instance': self.instance})

    def cancel(self, task, reason='explicit_cancel'):
        return self.command(task, 'cancel', {'producer_instance': self.instance, 'reason': reason})

    def wait(self, task, cancelled=lambda: False):
        deadline = time.monotonic()+480
        while True:
            require(time.monotonic() < deadline, 'scheduler_unavailable', 503)
            if cancelled():
                self.cancel(task)
                raise Rejected('cancelled')
            try:
                self.producer_heartbeat(task)
                value = self.get(task)
            except Rejected as error:
                if error.status != 503:
                    raise
                time.sleep(.5)
                continue
            if value['state'] == 'granted':
                return value
            if value['state'] in TERMINAL:
                raise Rejected('resource_unavailable', 503)
            time.sleep(.25)


class Lease:
    def __init__(self, client, ticket, payload, *, process_exit=False, hard_stop=None):
        self.client, self.ticket, self.payload, self.process_exit = client, ticket, payload, process_exit
        self.task = ticket['task_id']
        self.grant = ticket['grant']
        require(isinstance(self.task,str) and re.fullmatch('sched_[a-f0-9]{32}',self.task), 'stale_grant')
        require(type(self.grant['generation']) is int and self.grant['generation'] > 0, 'stale_grant')
        self.fields = {'generation': self.grant['generation'], 'grant_token': self.grant['token']}
        self.lock = None
        self.stop = threading.Event()
        self.cancelled = threading.Event()
        self.thread = None
        self.execution_deadline = None
        self.claimed = False
        self.quarantined = False
        self.hard_stop = hard_stop

    def acquire(self):
        gpu = self.grant['gpu_uuid']
        if gpu:
            self.lock = GpuLock(Path(self.client.path).parent, gpu).acquire()
        peer = identity(os.getpid())
        try:
            value = self.client.command(self.task, 'claim', {**self.fields, 'payload_sha256': digest(self.payload),
                'unit': peer['unit'], 'invocation_id': peer['invocation_id']})
            self.claimed = True
            self.execution_deadline = value['execution_deadline']
        except BaseException:
            # A claim response may be lost after the server committed running.
            # No model code has run yet: publish this proof before releasing flock.
            try:
                self.receipt()
            finally:
                if self.lock:
                    self.lock.close()
            raise

        def pulse():
            last_ok = time.monotonic()
            while not self.stop.wait(2):
                if self.execution_deadline and time.time() >= self.execution_deadline+10 and self.hard_stop:
                    self.hard_stop()
                    return
                try:
                    value = self.client.command(self.task, 'heartbeat', {**self.fields, 'phase': 'inference'})
                    last_ok = time.monotonic()
                    if value['cancel_requested'] or time.time() >= self.execution_deadline:
                        self.cancelled.set()
                except Exception:
                    if time.monotonic()-last_ok >= 10:
                        self.cancelled.set()
        self.thread = threading.Thread(target=pulse, daemon=True)
        self.thread.start()
        return self

    def check(self):
        if self.cancelled.is_set() or time.time() >= self.execution_deadline:
            raise Rejected('cancelled' if self.cancelled.is_set() else 'deadline', 503)

    def finish(self, outcome='succeeded', error_code=None, *, cleanup_ok=True):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=3)
        if not cleanup_ok:
            self.quarantined = True
            if self.hard_stop:
                self.hard_stop()
            return
        try:
            self.client.command(self.task, 'finish', {**self.fields, 'outcome': outcome, 'error_code': error_code})
        except Exception:
            pass  # Receipt/exit and the lock allow recovery without this RPC.
        if self.process_exit:
            # RADAR owns flock until process exit; supervisor sends released after wait().
            return
        try:
            self.receipt(ready=self.ticket.get('kind') == 'image_init' and outcome == 'succeeded')
        except BaseException:
            self.quarantined = True
            if self.hard_stop:
                self.hard_stop()
            raise
        if self.lock:
            self.lock.close()
        try:
            self.client.command(self.task, 'released', self.fields)
        except Exception:
            pass

    def receipt(self, ready=False):
        receipt = {'identity': identity(os.getpid()), 'task_id': self.task,
            'generation': self.grant['generation'], 'released': True}
        path = Path(self.client.path).parent/('receipt-'+str(os.getpid())+'-'+self.task+'-'+str(self.grant['generation'])+'.json')
        temporary = path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(canonical(receipt))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        if ready:
            ready_path = path.with_name('ready-'+str(os.getpid())+'.json')
            ready_tmp = ready_path.with_suffix('.tmp')
            fd = os.open(ready_tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(canonical({'identity': receipt['identity'], 'ready': True}))
            ready_tmp.replace(ready_path)


def write_ticket(path, ticket, payload):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(canonical({'ticket': ticket, 'payload': payload}))


@contextmanager
def radar_execution(directory):
    client = Client.from_env('radar_runner')
    if client is None:
        yield None
        return
    path = Path(directory)/'scheduler-ticket.json'
    data = json.loads(path.read_text())
    lease = Lease(client, data['ticket'], data['payload'], process_exit=True).acquire()
    outcome, error = 'succeeded', None
    try:
        yield lease
    except BaseException:
        outcome, error = 'failed', 'execution_failed'
        raise
    finally:
        lease.finish(outcome, error)
        path.unlink(missing_ok=True)
        # Keep the Lease alive (including fd) through interpreter teardown.
        _exit_leases.append(lease)


_exit_leases = []
