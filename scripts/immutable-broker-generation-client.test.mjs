import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePinnedBrokerGeneration } from './immutable-broker-generation-client.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(manifest, content = Buffer.from('hello')) {
  const blobs = new Map();
  const fileDigest = digest(content);
  blobs.set(fileDigest, content);
  const value = typeof manifest === 'function' ? manifest(fileDigest, content.length) : manifest;
  const raw = Buffer.from(JSON.stringify(value));
  const manifestDigest = digest(raw);
  blobs.set(manifestDigest, raw);
  return { blobs, manifestDigest, get: async d => blobs.get(d) };
}
const apply = (d, size) => ({ schemaVersion: '1', agent: 'codex', kind: 'apply', files: [
  { path: 'skills/alpha/SKILL.md', digest: d, size },
] });

test('reads authenticated pinned generation without workspace path operations', async () => {
  const f = fixture(apply);
  const result = await resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex');
  assert.equal(result.files.get('skills/alpha/SKILL.md').toString(), 'hello');
  assert.equal(result.generation.agent, 'codex');
});

test('cleanup tombstone has no files', async () => {
  const f = fixture({ schemaVersion: '1', agent: 'codex', kind: 'cleanup', files: [] });
  const result = await resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex');
  assert.equal(result.files.size, 0);
});

test('rejects wrong agent and untrusted selector', async () => {
  const f = fixture(apply);
  await assert.rejects(resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'claude'));
  await assert.rejects(resolvePinnedBrokerGeneration(f.get, 'latest', 'codex'));
});

test('rejects tampered manifest and referenced blob', async () => {
  const f = fixture(apply);
  f.blobs.set(f.manifestDigest, Buffer.from('tampered'));
  await assert.rejects(resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'), /authentication/);
  const g = fixture(apply);
  g.blobs.set(g.blobs.keys().next().value, Buffer.from('tampered'));
  await assert.rejects(resolvePinnedBrokerGeneration(g.get, g.manifestDigest, 'codex'), /authentication/);
});

test('rejects traversal, duplicate, unsorted, and invalid file entries', async () => {
  for (const bad of ['../SKILL.md', '/etc/passwd', 'skills//SKILL.md', 'skills\\a', 'skills/\u0001']) {
    const f = fixture((d, size) => ({ ...apply(d, size), files: [{ path: bad, digest: d, size }] }));
    await assert.rejects(resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'));
  }
  const f = fixture((d, size) => ({ ...apply(d, size), files: [
    { path: 'skills/z', digest: d, size }, { path: 'skills/a', digest: d, size },
  ] }));
  await assert.rejects(resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'), /sorted/);
  const g = fixture((d, size) => ({ ...apply(d, size), files: [
    { path: 'skills/a', digest: d, size }, { path: 'skills/a', digest: d, size },
  ] }));
  await assert.rejects(resolvePinnedBrokerGeneration(g.get, g.manifestDigest, 'codex'), /sorted/);
});

test('rejects oversized aggregate, malformed schema, and size mismatch', async () => {
  const f = fixture((d) => ({ ...apply(d, 0), files: [
    { path: 'skills/a', digest: d, size: 32 * 1024 * 1024 },
    { path: 'skills/b', digest: d, size: 1 },
  ] }));
  await assert.rejects(resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'), /total byte limit/);
  const g = fixture((d, size) => ({ ...apply(d, size), schemaVersion: '2' }));
  await assert.rejects(resolvePinnedBrokerGeneration(g.get, g.manifestDigest, 'codex'), /manifest/);
  const h = fixture((d, size) => ({ ...apply(d, size), files: [{ path: 'skills/a', digest: d, size: size + 1 }] }));
  await assert.rejects(resolvePinnedBrokerGeneration(h.get, h.manifestDigest, 'codex'), /size mismatch/);
});
