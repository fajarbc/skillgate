#!/usr/bin/env python3
"""Opt-in Linux root-only SO_PEERCRED proxy integration smoke.

Exercises the actual Python proxy with a minimal protocol backend. This tests
peer authorization, NOT the built Node broker or immutable-store durability.
Run only on an isolated host; temporary numeric UIDs are not reserved globally.
"""
import os
import grp
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time

BACKEND = r'''
import asyncio, os, sys
socket_path, log_path = sys.argv[1:]
os.umask(0o117)
async def handle(reader, writer):
    try:
        data = await reader.readline()
        with open(log_path, 'ab') as log:
            log.write(data)
        writer.write(b'{"v":1,"ok":true,"bytes":"aGVsbG8="}\n')
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()
async def main():
    server = await asyncio.start_unix_server(handle, path=socket_path)
    async with server:
        await server.serve_forever()
asyncio.run(main())
'''
CLIENT = r'''
import socket, sys
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(3)
    client.connect(sys.argv[1])
    client.sendall(b'{"v":1,"op":"get","digest":"' + b'a'*64 + b'"}\n')
    try:
        result = client.recv(4096)
    except (ConnectionResetError, BrokenPipeError):
        result = b''
    print(result.hex())
'''
RESPONSE = b'{"v":1,"ok":true,"bytes":"aGVsbG8="}\n'


def choose_ids():
    chosen = []
    for uid in range(61000, 64000):
        try:
            pwd.getpwuid(uid)
            continue
        except KeyError:
            pass
        try:
            grp.getgrgid(uid)
            continue
        except KeyError:
            chosen.append(uid)
            if len(chosen) == 4:
                return chosen
    raise RuntimeError('No free numeric test UIDs')


def dropped(uid, gid):
    return ['setpriv', '--reuid', str(uid), '--regid', str(gid),
            '--clear-groups', '--no-new-privs', '--bounding-set=-all']


def wait_socket(path, process):
    for _ in range(100):
        if path.is_socket():
            return
        if process.poll() is not None:
            raise RuntimeError('Service exited before socket creation')
        time.sleep(0.05)
    raise RuntimeError('Socket startup timed out')


def stop(process):
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def run():
    if sys.platform != 'linux' or os.geteuid() != 0 or not shutil.which('setpriv'):
        raise RuntimeError('Requires isolated Linux root host with setpriv')
    broker_uid, client_uid, outsider_uid, client_gid = choose_ids()
    proxy_script = Path(__file__).with_name('immutable-broker-auth-proxy.py')
    if not proxy_script.is_file():
        raise RuntimeError('Missing immutable-broker-auth-proxy.py')
    with tempfile.TemporaryDirectory(prefix='skillgate-peer-smoke-') as temp:
        base = Path(temp)
        base.chmod(0o755)  # root-owned ancestor; broker UID can traverse
        private = base / 'private'
        public = base / 'public'
        private.mkdir()
        public.mkdir()
        os.chown(private, broker_uid, client_gid)
        os.chown(public, broker_uid, client_gid)
        private.chmod(0o700)
        public.chmod(0o750)
        backend_socket = private / 'backend.sock'
        proxy_socket = public / 'proxy.sock'
        backend_log = private / 'backend.log'
        backend_log.touch(mode=0o600)
        os.chown(backend_log, broker_uid, client_gid)
        backend_log.chmod(0o600)
        backend = proxy = None
        try:
            backend = subprocess.Popen(dropped(broker_uid, client_gid) +
                [sys.executable, '-I', '-c', BACKEND, str(backend_socket), str(backend_log)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_socket(backend_socket, backend)
            env = dict(os.environ, SKILLGATE_BROKER_CLIENT_UID=str(client_uid),
                       SKILLGATE_BROKER_CLIENT_GID=str(client_gid))
            proxy = subprocess.Popen(dropped(broker_uid, client_gid) +
                [sys.executable, '-I', str(proxy_script), str(proxy_socket), str(backend_socket)],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_socket(proxy_socket, proxy)
            if (proxy_socket.stat().st_mode & 0o777) != 0o660:
                raise AssertionError('Proxy socket is not mode 0660')

            def client(uid, gid):
                completed = subprocess.run(dropped(uid, gid) +
                    [sys.executable, '-I', '-c', CLIENT, str(proxy_socket)],
                    capture_output=True, text=True, timeout=5)
                return completed

            authorized = client(client_uid, client_gid)
            if authorized.returncode or authorized.stdout.strip() != RESPONSE.hex():
                raise AssertionError(f'Authorized client failed: {authorized.stderr} {authorized.stdout}')
            before = backend_log.read_bytes()
            if before.count(b'\n') != 1:
                raise AssertionError('Expected one authorized backend request')
            unauthorized = client(outsider_uid, client_gid)
            if unauthorized.returncode or unauthorized.stdout.strip() != '':
                raise AssertionError('Unauthorized same-group UID was accepted')
            if backend_log.read_bytes() != before:
                raise AssertionError('Unauthorized request reached backend')
            print('PASS: authorized UID forwarded; same-GID unauthorized UID rejected')

            stop(proxy)
            stop(backend)
            proxy = backend = None
            proxy_socket.unlink()
            backend_socket.unlink()
            # A privileged attacker can spoof pathname ownership; kernel
            # credentials must still reject the actual root-owned backend.
            backend = subprocess.Popen([sys.executable, '-I', '-c', BACKEND,
                str(backend_socket), str(backend_log)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_socket(backend_socket, backend)
            os.chown(backend_socket, broker_uid, client_gid)
            backend_socket.chmod(0o660)
            proxy = subprocess.Popen(dropped(broker_uid, client_gid) +
                [sys.executable, '-I', str(proxy_script), str(proxy_socket), str(backend_socket)],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            wait_socket(proxy_socket, proxy)
            rejected = client(client_uid, client_gid)
            if rejected.returncode or rejected.stdout.strip() != '':
                raise AssertionError('Wrong-UID backend was accepted')
            if backend_log.read_bytes() != before:
                raise AssertionError('Request reached forged backend')
            print('PASS: forged backend socket metadata rejected by kernel SO_PEERCRED')
        finally:
            stop(proxy)
            stop(backend)


if __name__ == '__main__':
    try:
        run()
    except (RuntimeError, AssertionError, OSError, subprocess.SubprocessError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
