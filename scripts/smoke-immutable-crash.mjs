/** Real SIGKILL recovery smoke test for the built immutable generation backend.
 * Run after `npm run build` on a POSIX host: npm run smoke:immutable-crash.
 * No production test hooks or workspace path mutations are required.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform === 'win32') {
  console.error('SKIP: SIGKILL recovery smoke requires a POSIX host');
  process.exit(0);
}

const moduleUrl = new URL('../dist/adapters/immutable-generation.js', import.meta.url).href;
const { previewImmutableGeneration, publishImmutableGeneration, readImmutableGeneration } =
  await import(moduleUrl);
const files = { 'skills/a.md': Buffer.from('# Managed skill\n') };
const expected = previewImmutableGeneration('codex', 'apply', files);
const fileDigest = createHash('sha256').update(files['skills/a.md']).digest('hex');

// The FileHandle prototype is patched only inside the expendable child process.
// For one-file generations: sync #1 stages the content, #2 persists its link,
// #3 stages the manifest, and #4 persists the manifest link.
const worker = `
import { open } from 'node:fs/promises';
const [store, phaseText, moduleUrl] = process.argv.slice(1);
const phase = Number(phaseText);
const probe = await open(store, 'r');
const prototype = Object.getPrototypeOf(probe);
const originalSync = prototype.sync;
await probe.close();
let syncCount = 0;
prototype.sync = async function (...args) {
  await originalSync.apply(this, args);
  if (++syncCount === phase) {
    // Keep the process alive while the parent delivers a real SIGKILL.
    setInterval(() => {}, 1000);
    process.stdout.write('PAUSED\\n');
    await new Promise(() => {});
  }
};
const { publishImmutableGeneration } = await import(moduleUrl);
await publishImmutableGeneration(store, 'codex', 'apply', {
  'skills/a.md': Buffer.from('# Managed skill\\n'),
});
process.stdout.write('UNEXPECTED_COMPLETION\\n');
`;

async function killDuringPublication(store, phase) {
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', worker, store, String(phase), moduleUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker phase ${phase} timed out: ${stderr}`)), 10000);
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('UNEXPECTED_COMPLETION')) {
          clearTimeout(timer);
          reject(new Error(`Worker completed before SIGKILL in phase ${phase}`));
        } else if (stdout.includes('PAUSED\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Worker exited before pause (${code}, ${signal}): ${stderr}`));
      });
    });
    assert.equal(child.kill('SIGKILL'), true, 'SIGKILL delivery failed');
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
  }
}

for (const phase of [1, 2, 3, 4]) {
  const store = await mkdtemp(join(tmpdir(), 'skillgate-sigkill-'));
  try {
    await killDuringPublication(store, phase);
    const names = await readdir(store);
    const hasManifest = names.includes(expected.digest);
    assert.equal(hasManifest, phase === 4, `unexpected manifest visibility at sync ${phase}`);
    if (hasManifest) {
      const resolved = await readImmutableGeneration(store, expected.digest);
      assert.deepEqual(resolved.generation, expected.generation);
      assert.deepEqual(resolved.files.get('skills/a.md'), files['skills/a.md']);
    } else {
      await assert.rejects(readImmutableGeneration(store, expected.digest));
    }
    assert.equal(names.includes(fileDigest), phase >= 2,
      `unexpected content publication at sync ${phase}`);
    const recovered = await publishImmutableGeneration(store, 'codex', 'apply', files);
    assert.equal(recovered.digest, expected.digest);
    const resolved = await readImmutableGeneration(store, expected.digest);
    assert.deepEqual(resolved.files.get('skills/a.md'), files['skills/a.md']);
    console.log(`PASS: SIGKILL at sync ${phase}; retry converges to verified generation`);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}
