#!/usr/bin/env python3
"""Linux SO_PEERCRED gate for the experimental SkillGate immutable broker.

The Node broker MUST listen in a separate broker-owned 0700 directory. The
public proxy socket is broker-owned and group-accessible, but peer UID and GID
are verified by the kernel before forwarding any request bytes.
"""
import asyncio
from collections import deque
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import time

MAX_BLOB_BYTES = 32 * 1024 * 1024
MAX_WIRE_BYTES = 4 * ((MAX_BLOB_BYTES + 2) // 3) + 2048
MAX_REQUESTS_PER_MINUTE = 64
MAX_REQUEST_BYTES_PER_MINUTE = 256 * 1024 * 1024
# Tiny GET requests can amplify into large responses; bound egress separately.
MAX_RESPONSE_BYTES_PER_MINUTE = 256 * 1024 * 1024
MAX_CONNECTION_SECONDS = 15


def reject(message):
    raise RuntimeError('Immutable broker proxy configuration: ' + message)


def positive_id(name):
    raw = os.environ.get(name, '')
    if not raw.isascii() or not raw.isdecimal() or raw.startswith('0'):
        reject('explicit non-root client UID/GID required')
    value = int(raw)
    if value > 2**31 - 1:
        reject('client UID/GID out of range')
    return value


def check_identity():
    if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED'):
        reject('Linux SO_PEERCRED is required')
    uids, gids = os.getresuid(), os.getresgid()
    if 0 in uids + gids or len(set(uids)) != 1 or len(set(gids)) != 1:
        reject('a dedicated non-root real/effective/saved UID and GID are required')
    if set(os.getgroups()) - {gids[0]}:
        reject('supplementary groups are forbidden')
    try:
        fields = {}
        for line in Path('/proc/self/status').read_text().splitlines():
            key, _, value = line.partition(':')
            fields[key] = value.strip()
        if any(int(fields[key], 16) for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')):
            reject('Linux capabilities are forbidden')
        if fields['NoNewPrivs'] != '1':
            reject('NoNewPrivs must be enabled')
        if list(map(int, fields['Uid'].split())) != [uids[0]] * 4 or \
                list(map(int, fields['Gid'].split())) != [gids[0]] * 4:
            reject('saved or filesystem credentials differ')
    except (KeyError, ValueError, OSError):
        reject('unable to verify Linux process credentials')
    return uids[0], gids[0]


def check_ancestors(path, owner, private_parent):
    if not path.startswith('/') or path.startswith('//') or path == '/' or \
            os.path.normpath(path) != path or '\0' in path:
        reject('absolute canonical socket paths required')
    parent = os.path.dirname(path)
    ancestors = []
    cursor = parent
    while cursor != '/':
        ancestors.append(cursor)
        cursor = os.path.dirname(cursor)
    ancestors.append('/')
    for part in reversed(ancestors):
        st = os.lstat(part)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, owner):
            reject('socket ancestry is untrusted')
        if part == parent:
            if st.st_uid != owner or (st.st_mode & (0o077 if private_parent else 0o022)):
                reject('socket parent has unsafe ownership or permissions')
        elif st.st_mode & 0o022 and not st.st_mode & 0o1000:
            reject('socket ancestor is writable without sticky protection')


def check_backend(path, uid, gid):
    check_ancestors(path, uid, True)
    entry = os.lstat(path)
    if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != uid or \
            entry.st_gid != gid or (entry.st_mode & 0o777) != 0o660:
        reject('private broker socket has unsafe identity or permissions')


async def main():
    if len(sys.argv) != 3:
        reject('usage: proxy <public-socket> <private-broker-socket>')
    uid, gid = check_identity()
    client_uid = positive_id('SKILLGATE_BROKER_CLIENT_UID')
    client_gid = positive_id('SKILLGATE_BROKER_CLIENT_GID')
    if client_uid == uid or client_gid != gid:
        reject('client UID must differ and client GID must equal proxy GID')
    public, backend = sys.argv[1:]
    if public == backend:
        reject('public and private socket must differ')
    check_ancestors(public, uid, False)
    check_backend(backend, uid, gid)
    if os.path.lexists(public):
        reject('public socket already exists; refusing to unlink it')
    os.umask(0o117)
    active = False
    quota = deque()

    async def exchange(reader, writer):
        nonlocal active
        if active:
            writer.transport.abort()
            return
        active = True
        upstream_writer = None
        try:
            peer_socket = writer.get_extra_info('socket')
            credentials = peer_socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, peer_uid, peer_gid = struct.unpack('3i', credentials)
            if (peer_uid, peer_gid) != (client_uid, client_gid):
                return
            now = time.monotonic()
            while quota and now - quota[0][0] >= 60:
                quota.popleft()
            if len(quota) >= MAX_REQUESTS_PER_MINUTE:
                return
            request = await reader.readuntil(b'\n')
            if len(request) > MAX_WIRE_BYTES or sum(item[1] for item in quota) + len(request) > MAX_REQUEST_BYTES_PER_MINUTE:
                return
            # A rejected oversized response still consumes backend work.
            # Once the budget is exhausted, refuse before contacting the broker.
            if sum(item[2] for item in quota) >= MAX_RESPONSE_BYTES_PER_MINUTE:
                return
            quota.append([time.monotonic(), len(request), 0])
            check_backend(backend, uid, gid)
            upstream_reader, upstream_writer = await asyncio.open_unix_connection(backend, limit=MAX_WIRE_BYTES + 1)
            upstream_writer.write(request)
            await upstream_writer.drain()
            response = await upstream_reader.readuntil(b'\n')
            if len(response) > MAX_WIRE_BYTES:
                return
            # Account for upstream bytes even when this response is denied:
            # otherwise repeated over-budget GETs can force unbounded reads.
            quota[-1][2] = len(response)
            if sum(item[2] for item in quota) > MAX_RESPONSE_BYTES_PER_MINUTE:
                return
            writer.write(response)
            await writer.drain()
            # drain() only waits until the transport drops below its low-water
            # mark; abort() can discard a buffered response tail. Close
            # gracefully and wait for queued bytes to flush. The enclosing
            # 15-second wait_for still aborts stalled clients on timeout.
            writer.close()
            await writer.wait_closed()
        except (OSError, ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            pass
        finally:
            # abort() does not wait for an uncooperative peer to drain a large
            # response. A blocking wait_closed() here would pin the only slot.
            if upstream_writer is not None:
                upstream_writer.transport.abort()
            writer.transport.abort()
            active = False

    async def timed_exchange(reader, writer):
        try:
            await asyncio.wait_for(exchange(reader, writer), MAX_CONNECTION_SECONDS)
        except asyncio.TimeoutError:
            writer.transport.abort()

    server = await asyncio.start_unix_server(timed_exchange, path=public, limit=MAX_WIRE_BYTES + 1)
    entry = os.lstat(public)
    if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != uid or \
            entry.st_gid != gid or (entry.st_mode & 0o777) != 0o660:
        server.close()
        await server.wait_closed()
        reject('public socket has unsafe ownership or permissions')
    print('SkillGate authenticated immutable proxy listening', file=sys.stderr, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

