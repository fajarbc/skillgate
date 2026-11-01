"""Dependency-free bounded broker response tests.

Run with: python3 -m unittest discover -s scripts -p 'test_immutable_broker_auth_proxy.py'
"""
import asyncio
from collections import deque
import os
import socket
import sys
import tempfile
from types import SimpleNamespace
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('immutable-broker-auth-proxy.py')
spec = importlib.util.spec_from_file_location('skillgate_broker_proxy', source)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class ReadOnlyProxyFrameTests(unittest.TestCase):
    def test_canonical_get_is_accepted(self):
        request = b'{"v":1,"op":"get","digest":"' + b'a' * 64 + b'"}\n'
        self.assertIsNotNone(proxy.READ_ONLY_GET_FRAME.fullmatch(request))

    def test_put_and_ambiguous_or_noncanonical_frames_are_denied(self):
        get = b'{"v":1,"op":"get","digest":"' + b'a' * 64 + b'"}\n'
        rejected = [
            b'{"v":1,"op":"put","bytes":"eA=="}\n',
            get.replace(b'"get"', b'"put"'),
            get.replace(b'"op":"get"', b'"op":"put","op":"get"'),
            get.replace(b'"op":"get"', b'"op":"get","op":"put"'),
            get.replace(b'"v":1', b'"v":2'),
            get.replace(b'a' * 64, b'A' * 64),
            get.replace(b'"op"', b' "op"'),
            get + b'garbage',
            get[:-1],
        ]
        for request in rejected:
            with self.subTest(request=request[:100]):
                self.assertIsNone(proxy.READ_ONLY_GET_FRAME.fullmatch(request))


class BoundedResponseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_wire = proxy.MAX_WIRE_BYTES
        self.original_budget = proxy.MAX_RESPONSE_BYTES_PER_MINUTE

    def tearDown(self):
        proxy.MAX_WIRE_BYTES = self.original_wire
        proxy.MAX_RESPONSE_BYTES_PER_MINUTE = self.original_budget

    @staticmethod
    def make_quota(previous=0):
        entry = [0, 10, 0]
        quota = deque([[0, 0, previous], entry]) if previous else deque([entry])
        return quota, entry

    async def test_complete_response_charges_all_chunks(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'{"ok":')
        reader.feed_data(b'true}\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertEqual(await proxy.read_bounded_backend_response(reader, quota, entry), b'{"ok":true}\n')
        self.assertEqual(entry[2], len(b'{"ok":true}\n'))

    async def test_truncated_backend_charges_partial_bytes(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'partial-response')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_backend_response(reader, quota, entry))
        self.assertEqual(entry[2], len(b'partial-response'))

    async def test_response_over_remaining_quota_is_denied_and_charged(self):
        proxy.MAX_RESPONSE_BYTES_PER_MINUTE = 10
        reader = asyncio.StreamReader()
        reader.feed_data(b'123456789\n')
        reader.feed_eof()
        quota, entry = self.make_quota(previous=6)
        self.assertIsNone(await proxy.read_bounded_backend_response(reader, quota, entry))
        self.assertEqual(entry[2], 5)
        self.assertGreater(sum(item[2] for item in quota), 10)

    async def test_invalid_multiline_response_is_charged(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'one\ntwo\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_backend_response(reader, quota, entry))
        self.assertEqual(entry[2], 8)

    async def test_absolute_timeout_preserves_partial_accounting(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'partial')
        quota, entry = self.make_quota()
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(proxy.read_bounded_backend_response(reader, quota, entry), 0.02)
        self.assertEqual(entry[2], 7)

    async def test_wire_limit_rejects_and_charges_overshoot(self):
        proxy.MAX_WIRE_BYTES = 4
        reader = asyncio.StreamReader()
        reader.feed_data(b'abcdef\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_backend_response(reader, quota, entry))
        self.assertEqual(entry[2], 5)




class BoundedRequestTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_wire = proxy.MAX_WIRE_BYTES
        self.original_budget = proxy.MAX_REQUEST_BYTES_PER_MINUTE

    def tearDown(self):
        proxy.MAX_WIRE_BYTES = self.original_wire
        proxy.MAX_REQUEST_BYTES_PER_MINUTE = self.original_budget

    @staticmethod
    def make_quota(previous=0):
        entry = [0, 0, 0]
        quota = deque([[0, previous, 0], entry]) if previous else deque([entry])
        return quota, entry

    @unittest.skipIf(sys.platform == 'win32', 'requires Unix sockets')
    async def test_small_transport_buffer_accepts_large_request(self):
        # StreamReader's high-water mark is not the maximum frame size.
        # Keep buffering bounded even when a peer pipelines bytes after a
        # complete request; large valid frames must still stream successfully.
        payload = b'{' + b'x' * (1024 * 1024) + b'}\n'
        self.assertLess(proxy.STREAM_BUFFER_BYTES, len(payload))
        completed = asyncio.get_running_loop().create_future()

        async def handle(reader, writer):
            quota, entry = self.make_quota()
            try:
                frame = await proxy.read_bounded_client_request(reader, quota, entry)
                completed.set_result((frame, entry[1]))
            except Exception as error:
                completed.set_exception(error)
            finally:
                writer.close()
                await writer.wait_closed()

        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'proxy-test.sock')
            server = await asyncio.start_unix_server(
                handle, path=path, limit=proxy.STREAM_BUFFER_BYTES)
            async with server:
                _reader, writer = await asyncio.open_unix_connection(
                    path, limit=proxy.STREAM_BUFFER_BYTES)
                try:
                    writer.write(payload)
                    await writer.drain()
                    frame, charged = await asyncio.wait_for(completed, 10)
                    self.assertEqual(frame, payload)
                    self.assertEqual(charged, len(payload))
                finally:
                    writer.close()
                    await writer.wait_closed()

    async def test_complete_request_charges_all_bytes(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'{"v":1}\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertEqual(await proxy.read_bounded_client_request(reader, quota, entry), b'{"v":1}\n')
        self.assertEqual(entry[1], 8)

    async def test_unterminated_request_charges_partial_bytes(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'incomplete')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_client_request(reader, quota, entry))
        self.assertEqual(entry[1], 10)

    async def test_request_over_remaining_quota_is_denied_and_charged(self):
        proxy.MAX_REQUEST_BYTES_PER_MINUTE = 10
        reader = asyncio.StreamReader()
        reader.feed_data(b'abcdefghij\n')
        reader.feed_eof()
        quota, entry = self.make_quota(previous=6)
        self.assertIsNone(await proxy.read_bounded_client_request(reader, quota, entry))
        self.assertEqual(entry[1], 5)

    async def test_invalid_multiline_request_is_charged(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'one\ntwo\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_client_request(reader, quota, entry))
        self.assertEqual(entry[1], 8)

    async def test_trailing_bytes_after_newline_are_rejected(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'one\nextra')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_client_request(reader, quota, entry))
        self.assertEqual(entry[1], 9)

    async def test_timeout_preserves_partial_accounting(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'partial')
        quota, entry = self.make_quota()
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(proxy.read_bounded_client_request(reader, quota, entry), 0.02)
        self.assertEqual(entry[1], 7)

    async def test_wire_limit_rejects_and_charges_overshoot(self):
        proxy.MAX_WIRE_BYTES = 4
        reader = asyncio.StreamReader()
        reader.feed_data(b'abcdef\n')
        reader.feed_eof()
        quota, entry = self.make_quota()
        self.assertIsNone(await proxy.read_bounded_client_request(reader, quota, entry))
        self.assertEqual(entry[1], 5)


class RollingQuotaWindowTests(unittest.IsolatedAsyncioTestCase):
    """Delayed I/O must not make old work disappear at request-start + 60s."""

    async def test_delayed_backend_bytes_remain_charged(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'late-response\n')
        reader.feed_eof()
        entry = [0, 0, 0]
        quota = deque([entry])
        with patch.object(proxy.time, 'monotonic', return_value=14):
            self.assertEqual(
                await proxy.read_bounded_backend_response(reader, quota, entry),
                b'late-response\n')
        self.assertEqual(entry[0], 14)
        now = 60
        while quota and now - quota[0][0] >= 60:
            quota.popleft()
        self.assertEqual(sum(item[2] for item in quota), len(b'late-response\n'))

    async def test_delayed_request_bytes_remain_charged(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b'late-request\n')
        reader.feed_eof()
        entry = [0, 0, 0]
        quota = deque([entry])
        with patch.object(proxy.time, 'monotonic', return_value=14):
            self.assertEqual(
                await proxy.read_bounded_client_request(reader, quota, entry),
                b'late-request\n')
        self.assertEqual(entry[0], 14)
        now = 60
        while quota and now - quota[0][0] >= 60:
            quota.popleft()
        self.assertEqual(sum(item[1] for item in quota), len(b'late-request\n'))


@unittest.skipUnless(sys.platform == 'linux' and hasattr(socket, 'SO_PEERCRED'),
                     'requires Linux SO_PEERCRED')
class KernelPeerIdentityTests(unittest.TestCase):
    def test_actual_unix_socket_peer_matches_only_pinned_uid_and_gid(self):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            writer = SimpleNamespace(get_extra_info=lambda key: left if key == 'socket' else None)
            self.assertTrue(proxy.matches_kernel_peer(writer, os.getuid(), os.getgid()))
            self.assertFalse(proxy.matches_kernel_peer(writer, os.getuid() + 1, os.getgid()))
            self.assertFalse(proxy.matches_kernel_peer(writer, os.getuid(), os.getgid() + 1))
        finally:
            left.close()
            right.close()

    def test_missing_peer_socket_is_rejected(self):
        writer = SimpleNamespace(get_extra_info=lambda _: None)
        self.assertFalse(proxy.matches_kernel_peer(writer, os.getuid(), os.getgid()))

    def test_malformed_kernel_credentials_are_rejected(self):
        fake_socket = SimpleNamespace(getsockopt=lambda *_: b'bad')
        writer = SimpleNamespace(get_extra_info=lambda _: fake_socket)
        self.assertFalse(proxy.matches_kernel_peer(writer, os.getuid(), os.getgid()))


@unittest.skipUnless(sys.platform == 'linux', 'requires Linux statfs')
class GenuineProcfsTests(unittest.TestCase):
    def test_real_proc_status_has_procfs_magic(self):
        self.assertTrue(proxy.is_genuine_procfs('/proc/self/status'))

    def test_forged_status_on_regular_filesystem_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory, 'status')
            status.write_text('Uid:\t123 123 123 123\nNoNewPrivs:\t1\n')
            self.assertFalse(proxy.is_genuine_procfs(str(status)))

    def test_missing_procfs_fails_closed(self):
        self.assertFalse(proxy.is_genuine_procfs('/nonexistent-skillgate-proc/status'))

    def test_unavailable_statfs_fails_closed(self):
        with patch.object(proxy.ctypes, 'CDLL', side_effect=OSError('libc unavailable')):
            self.assertFalse(proxy.is_genuine_procfs())

    def test_identity_check_rejects_forged_procfs_before_using_status(self):
        with patch.object(proxy, 'is_genuine_procfs', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'genuine Linux procfs'):
                proxy.check_identity()


class GenerationQuotaCompatibilityTests(unittest.TestCase):
    def test_full_generation_publish_and_read_fit_request_window(self):
        # One manifest and up to 256 distinct file blobs per operation.
        # A rate limit below 514 makes a valid maximum-size generation
        # impossible to publish and immediately consume via this proxy.
        self.assertEqual(proxy.MAX_GENERATION_FILES, 256,
                         'proxy capacity must track the v1 generation format')
        required = 2 * (proxy.MAX_GENERATION_FILES + 1)
        self.assertGreaterEqual(proxy.MAX_REQUESTS_PER_MINUTE, required)
        # Keep the request-count limit finite; the byte and connection
        # budgets remain independent resource-exhaustion protections.
        self.assertLessEqual(proxy.MAX_REQUESTS_PER_MINUTE, 1024)

    def test_byte_budgets_still_bound_maximum_blob_round_trip(self):
        # A 32 MiB blob expands on the wire via base64. Publication and
        # retrieval must each fit within their respective rolling budgets.
        self.assertGreaterEqual(proxy.MAX_REQUEST_BYTES_PER_MINUTE, proxy.MAX_WIRE_BYTES)
        self.assertGreaterEqual(proxy.MAX_RESPONSE_BYTES_PER_MINUTE, proxy.MAX_WIRE_BYTES)


if __name__ == '__main__':
    unittest.main()
