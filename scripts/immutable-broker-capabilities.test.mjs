import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertNoBrokerCapabilities } from './immutable-broker-capabilities.mjs';

const clean = `Name:\tnode\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n`;
const options = status => ({ platform: 'linux', statusFilesystem: () => 0x9fa0, readStatus: () => status });

test('accepts zero capabilities with no-new-privileges enabled', () => {
  assert.doesNotThrow(() => assertNoBrokerCapabilities(options(clean)));
});
for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
  test(`rejects retained ${field} even with non-root UID`, () => {
    const modified = clean.replace(new RegExp(`(${field}:\\s*)0000000000000000`), '$10000000000000001');
    assert.throws(() => assertNoBrokerCapabilities(options(modified)), new RegExp(field));
  });
}
test('rejects missing, duplicate, or malformed capability fields', () => {
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace(/^CapEff:.*\n/m, ''))), /CapEff/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean + 'CapEff:\t0\n')), /CapEff/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace(/CapAmb:\s*0+/, 'CapAmb:\tzz'))), /CapAmb/);
});
test('rejects absent or disabled no-new-privileges', () => {
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace(/^NoNewPrivs:.*\n/m, ''))), /NoNewPrivs/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'))), /NoNewPrivs/);
});
test('rejects non-Linux and non-procfs status sources', () => {
  assert.throws(() => assertNoBrokerCapabilities({ ...options(clean), platform: 'darwin' }), /Linux/);
  assert.throws(() => assertNoBrokerCapabilities({ ...options(clean), statusFilesystem: () => 0 }), /verify/);
  assert.throws(() => assertNoBrokerCapabilities({ ...options(clean), readStatus: () => { throw Error('no proc'); } }), /verify/);
});
test('checks actual kernel credentials on this Linux host', () => {
  if (process.platform !== 'linux') return;
  const status = readFileSync('/proc/self/status', 'utf8');
  const clear = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']
    .every(field => new RegExp(`^${field}:\\s*0+$`, 'm').test(status));
  const nnp = /^NoNewPrivs:\s*1$/m.test(status);
  if (clear && nnp) assert.doesNotThrow(() => assertNoBrokerCapabilities());
  else assert.throws(() => assertNoBrokerCapabilities(), /Cap|NoNewPrivs/);
});
