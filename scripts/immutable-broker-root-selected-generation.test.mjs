import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRootSelectedGeneration, readRootSelectedBrokerGeneration } from './immutable-broker-root-selected-generation.mjs';

const rootOnly = { skip: process.getuid?.() !== 0 ? 'root-owned fixture required' : false };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'skillgate-root-consumer-'));
  try { await chmod(dir, 0o755); await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function blobsFor(agent, kind = 'apply') {
  const file = Buffer.from('managed immutable skill');
  const fileDigest = digest(file);
  const generation = { schemaVersion: '1', agent, kind, files: kind === 'cleanup' ? [] : [
    { path: 'skills/example/SKILL.md', digest: fileDigest, size: file.length },
  ] };
  const raw = Buffer.from(JSON.stringify(generation));
  const generationDigest = digest(raw);
  const blobs = new Map([[generationDigest, raw], [fileDigest, file]]);
  return { blobs, generationDigest };
}

async function select(dir, agent, generationDigest) {
  const path = join(dir, 'selector');
  await writeFile(path, 'skillgate-generation-v1 ' + agent + ' ' + generationDigest + '\n', { mode: 0o644 });
  return path;
}

test('root-selected digest resolves verified generation and contents', rootOnly, async () => {
  await sandbox(async dir => {
    const { blobs, generationDigest } = blobsFor('codex');
    const path = await select(dir, 'codex', generationDigest);
    const requested = [];
    const result = await resolveRootSelectedGeneration(path, 'codex', async d => {
      requested.push(d);
      return blobs.get(d);
    });
    assert.deepEqual(requested, [generationDigest, result.generation.files[0].digest]);
    assert.equal(result.files.get('skills/example/SKILL.md').toString(), 'managed immutable skill');
  });
});

test('cleanup tombstone resolves to no files', rootOnly, async () => {
  await sandbox(async dir => {
    const { blobs, generationDigest } = blobsFor('codex', 'cleanup');
    const path = await select(dir, 'codex', generationDigest);
    const result = await resolveRootSelectedGeneration(path, 'codex', d => blobs.get(d));
    assert.equal(result.generation.kind, 'cleanup');
    assert.equal(result.files.size, 0);
  });
});

test('invalid selector and agent mismatch never access blob transport', rootOnly, async () => {
  await sandbox(async dir => {
    const { generationDigest } = blobsFor('codex');
    const path = await select(dir, 'codex', generationDigest);
    let calls = 0;
    const readBlob = async () => { calls++; throw new Error('must not read'); };
    await assert.rejects(resolveRootSelectedGeneration(path, 'claude', readBlob), /Untrusted/);
    await chmod(path, 0o666);
    await assert.rejects(resolveRootSelectedGeneration(path, 'codex', readBlob), /Untrusted/);
    assert.equal(calls, 0);
    await assert.rejects(readRootSelectedBrokerGeneration(path, '/nonexistent', 'codex', {}), /Untrusted/);
  });
});

test('symlink selector is rejected before any broker read', rootOnly, async () => {
  await sandbox(async dir => {
    const { generationDigest } = blobsFor('codex');
    const path = await select(dir, 'codex', generationDigest);
    const alias = join(dir, 'alias');
    await symlink(path, alias);
    let calls = 0;
    await assert.rejects(resolveRootSelectedGeneration(alias, 'codex', () => { calls++; }));
    assert.equal(calls, 0);
  });
});

test('root-selected but tampered manifest is rejected by digest verification', rootOnly, async () => {
  await sandbox(async dir => {
    const { blobs, generationDigest } = blobsFor('codex');
    const path = await select(dir, 'codex', generationDigest);
    blobs.set(generationDigest, Buffer.from('tampered'));
    await assert.rejects(resolveRootSelectedGeneration(path, 'codex', d => blobs.get(d)), /authentication/);
  });
});
