import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { mkdtemp, writeFile, chmod, symlink, link, rm, chown, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTrustedGenerationSelection, readBoundedSelectionBytes } from './immutable-broker-trusted-selection.mjs';

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

// Fake descriptor models a regular file that changes size after fstat().
function readerWithBytes(contents, chunkSize = contents.length) {
  let requested = 0;
  return {
    get requested() { return requested; },
    async read(target, offset, length, position) {
      requested += length;
      const count = Math.min(length, chunkSize, Math.max(0, contents.length - position));
      contents.copy(target, offset, position, position + count);
      return { bytesRead: count };
    },
  };
}

test('bounded selector read supports short reads without truncating', async () => {
  const data = Buffer.from(line);
  const reader = readerWithBytes(data, 3);
  assert.deepEqual(await readBoundedSelectionBytes(reader, data.length), data);
});

test('bounded selector read rejects concurrent growth and never reads beyond 193 bytes', async () => {
  const data = Buffer.alloc(1024 * 1024, 0x61);
  const reader = readerWithBytes(data);
  await assert.rejects(readBoundedSelectionBytes(reader, Buffer.byteLength(line)), /Untrusted/);
  assert.equal(reader.requested, 193);
});

test('bounded selector read rejects concurrent truncation and invalid expected sizes', async () => {
  await assert.rejects(readBoundedSelectionBytes(readerWithBytes(Buffer.alloc(4)), 10), /Untrusted/);
  await assert.rejects(readBoundedSelectionBytes(readerWithBytes(Buffer.alloc(1)), 193), /Untrusted/);
});

test('root-owned selector resists a concurrent non-cooperating UID', { ...rootOnly, timeout: 10000 }, async t => {
  if (process.platform !== 'linux') return t.skip('Linux UID isolation required');
  const privilegeDrop = ['--no-new-privs', '--bounding-set=-all', '--reuid', '61001',
    '--regid', '61002', '--clear-groups'];
  const probe = spawnSync('setpriv', [...privilegeDrop, 'id'], { timeout: 3000 });
  if (probe.status !== 0) return t.skip('setpriv and UID isolation unavailable');
  await sandbox(async dir => {
    const path = join(dir, 'selection');
    await writeFile(path, line, { mode: 0o644 });
    const attack = `const fs=require('node:fs');const p=process.argv[1];let success=0;
      for(let i=0;i<500;i++)for(const attempt of [
        ()=>fs.writeFileSync(p,'attacker'),()=>fs.unlinkSync(p),
        ()=>fs.renameSync(p,p+'.old'),()=>fs.symlinkSync('/etc/passwd',p)]){
        try{attempt();success++}catch(error){
          if(!['EACCES','EPERM','EEXIST'].includes(error.code))throw error;
        }
      }process.stdout.write(String(success));`;
    const attacker = spawn('setpriv', [...privilegeDrop, process.execPath, '-e', attack, path],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = new Promise((resolve, reject) => {
      attacker.once('exit', resolve);
      attacker.once('error', reject);
    });
    let output = '';
    let stderr = '';
    attacker.stdout.on('data', chunk => { output += chunk; });
    attacker.stderr.on('data', chunk => { stderr += chunk; });
    try {
      for (let i = 0; i < 500; i++) {
        assert.equal(await readTrustedGenerationSelection(path, 'codex'), DIGEST);
      }
      assert.equal(await exit, 0, stderr);
      assert.equal(output, '0', 'untrusted UID must not mutate root-controlled selector');
      assert.equal(await readFile(path, 'utf8'), line);
      assert.equal((await stat(path)).uid, 0);
    } finally {
      attacker.kill();
    }
  });
});
