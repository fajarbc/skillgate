import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { putBrokerBlob, getBrokerBlob } from './immutable-broker-client.mjs';

async function withServer(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), 'skillgate-broker-client-'));
  const path = join(dir, 'broker.sock');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let request = '';
    socket.on('data', chunk => {
      request += chunk.toString();
      if (request.endsWith('\n')) handler(socket, JSON.parse(request));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await run(path);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const payload = Buffer.from('trusted blob');
const digest = createHash('sha256').update(payload).digest('hex');
const reply = (socket, body) => socket.end(JSON.stringify(body) + '\n');

test('put snapshots bytes and authenticates returned digest', async () => {
  await withServer((socket, request) => {
    assert.equal(request.op, 'put');
    assert.equal(Buffer.from(request.bytes, 'base64').toString(), 'trusted blob');
    reply(socket, { v: 1, ok: true, digest, created: true });
  }, async path => {
    const input = Buffer.from(payload);
    const pending = putBrokerBlob(path, input);
    input.fill(0x78);
    assert.deepEqual(await pending, { digest, created: true });
  });
});

test('get authenticates returned bytes', async () => {
  await withServer((socket, request) => {
    assert.deepEqual(request, { v: 1, op: 'get', digest });
    reply(socket, { v: 1, ok: true, bytes: payload.toString('base64') });
  }, async path => assert.deepEqual(await getBrokerBlob(path, digest), payload));
});

test('rejects forged put digest', async () => {
  await withServer((socket) => reply(socket, { v: 1, ok: true, digest: '0'.repeat(64), created: true }),
    async path => assert.rejects(putBrokerBlob(path, payload), /authentication/));
});

test('rejects forged get content', async () => {
  await withServer(socket => reply(socket, { v: 1, ok: true, bytes: Buffer.from('evil').toString('base64') }),
    async path => assert.rejects(getBrokerBlob(path, digest), /digest mismatch/));
});

test('rejects noncanonical base64 and additional fields', async () => {
  await withServer(socket => reply(socket, { v: 1, ok: true, bytes: 'YQ=' }),
    async path => assert.rejects(getBrokerBlob(path, digest), /encoding/));
  await withServer(socket => reply(socket, { v: 1, ok: true, digest, created: true, unexpected: 1 }),
    async path => assert.rejects(putBrokerBlob(path, payload), /authentication/));
});

test('rejects multiple response frames and malformed JSON', async () => {
  await withServer(socket => socket.end('{"v":1,"ok":true}\n{"v":1,"ok":true}\n'),
    async path => assert.rejects(putBrokerBlob(path, payload), /framing/));
  await withServer(socket => socket.end('{broken}\n'),
    async path => assert.rejects(putBrokerBlob(path, payload), /JSON/));
});

test('rejects oversized response and a silent peer', async () => {
  await withServer(socket => socket.end('x'.repeat(4096) + '\n'),
    async path => assert.rejects(putBrokerBlob(path, payload), /byte limit/));
  await withServer(() => {},
    async path => assert.rejects(putBrokerBlob(path, payload, { timeoutMs: 50 }), /timeout/));
});

test('rejects invalid inputs before connection', async () => {
  await assert.rejects(getBrokerBlob('/not/connected', '../escape'), /digest/);
  await assert.rejects(putBrokerBlob('relative.sock', payload), /absolute/);
  await assert.rejects(putBrokerBlob('/not/connected', Buffer.alloc(32 * 1024 * 1024 + 1)), /32 MiB/);
});

test('keeps request write side open while the broker processes asynchronously', async () => {
  let prematurelyHalfClosed = false;
  await withServer((socket) => {
    let ended = false;
    socket.once('end', () => { ended = true; });
    setTimeout(() => {
      prematurelyHalfClosed = ended;
      reply(socket, { v: 1, ok: true, digest, created: false });
    }, 25);
  }, async path => {
    assert.deepEqual(await putBrokerBlob(path, payload), { digest, created: false });
    assert.equal(prematurelyHalfClosed, false);
  });
});
