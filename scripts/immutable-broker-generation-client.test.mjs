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

test('rejects coercible non-string generation selectors before transport', async () => {
  const f = fixture(apply);
  let reads = 0;
  let coercions = 0;
  const readBlob = async () => { reads++; throw new Error('unexpected transport read'); };
  const objectDigest = { toString() { coercions++; return f.manifestDigest; } };
  for (const invalid of [objectDigest, [f.manifestDigest], null, 123]) {
    await assert.rejects(
      resolvePinnedBrokerGeneration(readBlob, invalid, 'codex'),
      /Invalid pinned generation selection/,
    );
  }
  assert.equal(coercions, 0, 'never coerce an untrusted selector');
  assert.equal(reads, 0, 'never call transport for an invalid selector');
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


test('reuses authenticated shared blobs without exhausting proxy request quota', async () => {
  const content = Buffer.from('shared skill bytes');
  const f = fixture((d, size) => ({
    schemaVersion: '1', agent: 'codex', kind: 'apply',
    files: Array.from({ length: 256 }, (_, index) => ({
      path: `skills/${String(index).padStart(3, '0')}/SKILL.md`, digest: d, size,
    })),
  }), content);
  const reads = [];
  const result = await resolvePinnedBrokerGeneration(async d => {
    reads.push(d);
    return f.blobs.get(d);
  }, f.manifestDigest, 'codex');
  assert.deepEqual(reads, [f.manifestDigest, digest(content)],
    'manifest plus one unique blob must require only two broker requests');
  assert.equal(result.files.size, 256);
  const first = result.files.get('skills/000/SKILL.md');
  const second = result.files.get('skills/001/SKILL.md');
  first[0] = 0;
  assert.equal(second.toString(), content.toString(),
    'logical files must not share mutable Buffer objects');
});

test('reused digest still rejects inconsistent file sizes', async () => {
  const f = fixture((d, size) => ({
    schemaVersion: '1', agent: 'codex', kind: 'apply',
    files: [
      { path: 'skills/a', digest: d, size },
      { path: 'skills/b', digest: d, size: size + 1 },
    ],
  }));
  await assert.rejects(
    resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'),
    /size mismatch/,
  );
});

test('reused digest cannot bypass content authentication', async () => {
  const f = fixture((d, size) => ({
    schemaVersion: '1', agent: 'codex', kind: 'apply',
    files: [
      { path: 'skills/a', digest: d, size },
      { path: 'skills/b', digest: d, size },
    ],
  }));
  const contentDigest = digest(Buffer.from('hello'));
  f.blobs.set(contentDigest, Buffer.from('evil!'));
  await assert.rejects(
    resolvePinnedBrokerGeneration(f.get, f.manifestDigest, 'codex'),
    /authentication/,
  );
});

test('snapshots authenticated transport buffers before later awaited reads', async () => {
  const first = Buffer.from('first');
  const second = Buffer.from('other');
  const firstDigest = digest(first);
  const secondDigest = digest(second);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: '1', agent: 'codex', kind: 'apply',
    files: [
      { path: 'skills/a', digest: firstDigest, size: 5 },
      { path: 'skills/b', digest: secondDigest, size: 5 },
      { path: 'skills/c', digest: firstDigest, size: 5 },
    ],
  }));
  const manifestDigest = digest(manifest);
  const reads = [];
  const result = await resolvePinnedBrokerGeneration(async requested => {
    reads.push(requested);
    if (requested === manifestDigest) return manifest;
    if (requested === firstDigest) return first;
    if (requested === secondDigest) {
      // The transport still owns its returned Buffer. A subsequent awaited
      // read may mutate it, but cached authenticated content must not change.
      first.fill(0x58);
      return second;
    }
    throw new Error('Unexpected digest');
  }, manifestDigest, 'codex');
  assert.deepEqual(reads, [manifestDigest, firstDigest, secondDigest]);
  assert.equal(result.files.get('skills/a').toString(), 'first');
  assert.equal(result.files.get('skills/b').toString(), 'other');
  assert.equal(result.files.get('skills/c').toString(), 'first');
});
