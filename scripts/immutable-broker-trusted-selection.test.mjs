import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, symlink, link, rm, chown, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTrustedGenerationSelection } from './immutable-broker-trusted-selection.mjs';

const rootOnly = { skip: process.getuid?.() !== 0 ? 'root-owned fixture required' : false };
const DIGEST = 'a'.repeat(64);
const line = `skillgate-generation-v1 codex ${DIGEST}\n`;

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'skillgate-selection-'));
  try { await chmod(dir, 0o755); await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('accepts root-owned canonical pinned selection', rootOnly, async () => {
  await sandbox(async dir => {
    const path = join(dir, 'selection');
    await writeFile(path, line, { mode: 0o644 });
    assert.equal(await readTrustedGenerationSelection(path, 'codex'), DIGEST);
    await assert.rejects(readTrustedGenerationSelection(path, 'claude'), /Untrusted/);
  });
});

test('rejects malformed, oversized and untrusted file content', rootOnly, async () => {
  await sandbox(async dir => {
    const path = join(dir, 'selection');
    for (const bad of [line + '\n', line.replace('codex', 'claude'),
      line.replace('a'.repeat(64), 'A'.repeat(64)),
      Buffer.from(line).map(byte => byte === 97 ? 0xe1 : byte), 'x'.repeat(193)]) {
      await writeFile(path, bad);
      await assert.rejects(readTrustedGenerationSelection(path, 'codex'), /Untrusted/);
    }
  });
});

test('rejects symlinks, hardlinks, and writable selector', rootOnly, async () => {
  await sandbox(async dir => {
    const path = join(dir, 'selection');
    const alias = join(dir, 'alias');
    await writeFile(path, line);
    await symlink(path, alias);
    await assert.rejects(readTrustedGenerationSelection(alias, 'codex'));
    await rm(alias);
    await link(path, alias);
    await assert.rejects(readTrustedGenerationSelection(path, 'codex'));
    await rm(alias);
    await chmod(path, 0o666);
    await assert.rejects(readTrustedGenerationSelection(path, 'codex'));
  });
});

test('rejects untrusted parent and noncanonical path', rootOnly, async () => {
  await sandbox(async dir => {
    const parent = join(dir, 'unsafe');
    await mkdir(parent, { mode: 0o777 });
    await chmod(parent, 0o777);
    const path = join(parent, 'selection');
    await writeFile(path, line);
    await assert.rejects(readTrustedGenerationSelection(path, 'codex'));
    await assert.rejects(readTrustedGenerationSelection(`${dir}/../${dir.split('/').at(-1)}/unsafe/selection`, 'codex'));
  });
});

test('rejects a selector owned by an untrusted UID', rootOnly, async () => {
  await sandbox(async dir => {
    const path = join(dir, 'selection');
    await writeFile(path, line);
    await chown(path, 61001, 61001);
    await assert.rejects(readTrustedGenerationSelection(path, 'codex'), /Untrusted/);
  });
});
