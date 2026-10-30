import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareBrokerGeneration, publishBrokerGenerationWith } from './immutable-broker-generation-publisher.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function transport() {
  const blobs = new Map();
  const calls = [];
  return { blobs, calls, put: async bytes => {
    calls.push(Buffer.from(bytes));
    const digest = sha(bytes);
    blobs.set(digest, Buffer.from(bytes));
    return { digest, created: true };
  } };
}

test('publishes sorted immutable content before manifest, with digest-authenticated acknowledgements', async () => {
  const t = transport();
  const files = new Map([
    ['skills/z/SKILL.md', Buffer.from('Z')],
    ['skills/a/SKILL.md', Buffer.from('A')],
  ]);
  const result = await publishBrokerGenerationWith(t.put, 'codex', 'apply', files);
  assert.deepEqual(result.generation.files.map(f => f.path), ['skills/a/SKILL.md', 'skills/z/SKILL.md']);
  assert.deepEqual(t.calls.slice(0, 2).map(b => b.toString()), ['A', 'Z']);
  assert.equal(t.calls[2].toString(), JSON.stringify(result.generation));
  assert.equal(result.digest, sha(t.calls[2]));
  assert.equal(t.blobs.get(result.digest).toString(), JSON.stringify(result.generation));
});

test('snapshots caller buffers before the first asynchronous publication', async () => {
  const input = Buffer.from('original');
  const files = new Map([['skills/a/SKILL.md', input]]);
  const t = transport();
  const published = publishBrokerGenerationWith(async bytes => {
    await new Promise(resolve => setImmediate(resolve));
    return t.put(bytes);
  }, 'codex', 'apply', files);
  input.fill(0x58);
  files.clear();
  const result = await published;
  assert.equal(t.calls[0].toString(), 'original');
  assert.equal(result.generation.files[0].digest, sha(Buffer.from('original')));
});

test('rejects malformed inputs before any publication', async () => {
  const bad = [
    new Map([['../escape', Buffer.from('x')]]),
    new Map([['skills//x', Buffer.from('x')]]),
    new Map([['skills/\ud800', Buffer.from('x')]]),
    new Map([['skills/a', 'not a buffer']]),
    new Map([['skills/a', Buffer.alloc(32 * 1024 * 1024)], ['skills/b', Buffer.from('x')]]),
  ];
  for (const files of bad) {
    let calls = 0;
    await assert.rejects(publishBrokerGenerationWith(async () => { calls++; }, 'codex', 'apply', files));
    assert.equal(calls, 0);
  }
  await assert.rejects(publishBrokerGenerationWith(async () => {}, 'codex', 'cleanup',
    new Map([['skills/a', Buffer.from('x')]])));
});

test('fails closed on incorrect blob acknowledgement and never publishes manifest', async () => {
  let calls = 0;
  await assert.rejects(publishBrokerGenerationWith(async () => {
    calls++;
    return { digest: 'f'.repeat(64) };
  }, 'codex', 'apply', new Map([['skills/a', Buffer.from('x')]])), /acknowledgement mismatch/);
  assert.equal(calls, 1);
});

test('publishes a deterministic cleanup tombstone without workspace mutation', async () => {
  const t = transport();
  const result = await publishBrokerGenerationWith(t.put, 'codex', 'cleanup', new Map());
  assert.equal(t.calls.length, 1);
  assert.deepEqual(result.generation.files, []);
  assert.equal(result.generation.kind, 'cleanup');
  assert.equal(result.digest, sha(t.calls[0]));
  const preview = prepareBrokerGeneration('codex', 'cleanup', new Map());
  assert.equal(preview.digest, result.digest);
});

test('publisher manifests round-trip through existing pinned broker generation consumer', async () => {
  const { resolvePinnedBrokerGeneration } = await import('./immutable-broker-generation-client.mjs');
  const t = transport();
  const original = new Map([
    ['skills/z/SKILL.md', Buffer.from('Z')],
    ['skills/a/SKILL.md', Buffer.from('A')],
  ]);
  const published = await publishBrokerGenerationWith(t.put, 'codex', 'apply', original);
  const read = await resolvePinnedBrokerGeneration(d => t.blobs.get(d), published.digest, 'codex');
  assert.deepEqual(read.generation, published.generation);
  assert.deepEqual([...read.files], [...original].sort(([a], [b]) => a.localeCompare(b)));
  await assert.rejects(resolvePinnedBrokerGeneration(d => t.blobs.get(d), published.digest, 'claude'));
});

test('manifest acknowledgement mismatch is rejected even after content publication', async () => {
  let calls = 0;
  await assert.rejects(publishBrokerGenerationWith(async bytes => {
    calls++;
    return { digest: calls === 1 ? sha(bytes) : '0'.repeat(64) };
  }, 'codex', 'apply', new Map([['skills/a', Buffer.from('x')]])), /manifest acknowledgement mismatch/);
  assert.equal(calls, 2);
});

test('independent publications of unchanged inputs have identical generation digests', async () => {
  const files = new Map([['skills/a', Buffer.from('x')]]);
  const a = await publishBrokerGenerationWith(transport().put, 'codex', 'apply', files);
  const b = await publishBrokerGenerationWith(transport().put, 'codex', 'apply', files);
  assert.deepEqual(a, b);
});
