"""Authenticated HTTP over a local Unix socket. Never bind a TCP socket."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import struct
import threading
from http.server import BaseHTTPRequestHandler

from .core import Scheduler
from .protocol import ROLES, Rejected, canonical, require
from .runtime import Runtime, identity


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_rpc(self):
        self.connection.settimeout(2)
        try:
            pid, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(uid == os.getuid(), 'unauthorized', 401)
            auth = self.headers.get('Authorization', '')
            role = next((r for r, key in self.server.keys.items() if secrets.compare_digest(auth, 'Bearer '+key)), None)
            require(role is not None, 'unauthorized', 401)
            require(not self.headers.get('Transfer-Encoding'))
            length = self.headers.get('Content-Length', '0')
            require(length.isdigit() and int(length) <= 16384)
            body = json.loads(self.rfile.read(int(length))) if int(length) else {}
            require(isinstance(body, dict))
            parts = self.path.split('/')
            scheduler = self.server.scheduler
            code = 200
            if self.command == 'POST' and self.path == '/v1/tasks':
                code, value = scheduler.register(role, body, identity(pid))
            elif self.command == 'GET' and self.path == '/v1/status':
                require(role == 'operator', 'not_found', 404)
                value = scheduler.status()
            elif self.command == 'POST' and self.path in ('/v1/admin/drain', '/v1/admin/resume'):
                require(role == 'operator', 'not_found', 404)
                value = scheduler.admin(parts[-1], body)
            elif len(parts) in (4, 5) and parts[1:3] == ['v1', 'tasks']:
                require(parts[3].startswith('sched_') and len(parts[3]) == 38, 'not_found', 404)
                if len(parts) == 4 and self.command == 'GET':
                    value = scheduler.get(parts[3], role)
                else:
                    require(len(parts) == 5 and self.command == 'POST', 'not_found', 404)
                    value = scheduler.command(parts[3], parts[4], role, body, identity(pid))
            else:
                raise Rejected('not_found', 404)
        except Rejected as exc:
            code, value = exc.status, {'error': {'code': exc.code, 'retryable': exc.status in (429, 503)}}
        except (ValueError, TypeError, KeyError):
            code, value = 400, {'error': {'code': 'invalid_request', 'retryable': False}}
        except Exception:
            code, value = 503, {'error': {'code': 'scheduler_unavailable', 'retryable': True}}
        data = canonical(value).encode()
        if len(data) > 16384:
            code, data = 503, b'{"error":{"code":"response_limit","retryable":false}}'
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, TimeoutError):
            pass

    do_GET = do_POST = handle_rpc


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path, scheduler, keys):
        self.scheduler, self.keys = scheduler, keys
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(str(path), Handler)
        os.chmod(path, 0o600)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    runtime = Runtime(config['runtime_directory'], config['units'])
    import fcntl
    daemon_fd = os.open(runtime.directory/'daemon.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(daemon_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    socket_path = runtime.directory/'scheduler.sock'
    # Only the socket is replaced, after proving there is no other daemon.
    if socket_path.exists():
        require(socket_path.is_socket(), 'unsafe_socket')
        socket_path.unlink()
    keys = {role: Path(path).read_text().strip() for role, path in config['token_files'].items()}
    require(set(keys) == ROLES and len(set(keys.values())) == len(keys) and all(len(k) >= 32 for k in keys.values()))
    scheduler = Scheduler(config['database'], runtime, mode=config.get('mode', 'observe'),
        reserve_mib=config.get('host_reserve_mib', 12288))
    server = Server(socket_path, scheduler, keys)
    stop = threading.Event()

    def tick():
        while not stop.is_set():
            try:
                scheduler.tick()
            except Exception:
                scheduler.ready = False
                scheduler.failed = True
            stop.wait(.25)

    thread = threading.Thread(target=tick, daemon=True)
    thread.start()

    def shutdown(*args):
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=.25)
    finally:
        stop.set()
        thread.join(timeout=10)
        server.server_close()
        scheduler.close()
        os.close(daemon_fd)


if __name__ == '__main__':
    main()
