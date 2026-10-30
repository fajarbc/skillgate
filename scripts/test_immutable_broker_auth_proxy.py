"""Dependency-free bounded broker response tests.

Run with: python3 -m unittest discover -s scripts -p 'test_immutable_broker_auth_proxy.py'
"""
import asyncio
from collections import deque
import os
import socket
import sys
from types import SimpleNamespace
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('immutable-broker-auth-proxy.py')
spec = importlib.util.spec_from_file_location('skillgate_broker_proxy', source)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


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


if __name__ == '__main__':
    unittest.main()
