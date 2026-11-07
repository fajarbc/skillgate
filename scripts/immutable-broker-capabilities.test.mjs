import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { assertNoBrokerCapabilities } from './immutable-broker-capabilities.mjs';

const clean = `Name:\tnode\nUid:\t12001\t12001\t12001\t12001\nGid:\t12002\t12002\t12002\t12002\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n`;
const credentials = () => ({ uid: 12001, euid: 12001, gid: 12002, egid: 12002 });
const options = status => ({ platform: 'linux', statusFilesystem: () => 0x9fa0, readStatus: () => status, credentials });

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
test('rejects saved root and mismatched filesystem IDs with zero capabilities', () => {
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('Uid:\t12001\t12001\t12001\t12001', 'Uid:\t12001\t12001\t0\t12001'))), /Uid/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('Gid:\t12002\t12002\t12002\t12002', 'Gid:\t12002\t12002\t0\t12002'))), /Gid/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('Uid:\t12001\t12001\t12001\t12001', 'Uid:\t12001\t12001\t12001\t0'))), /Uid/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('Gid:\t12002\t12002\t12002\t12002', 'Gid:\t12002\t12002\t12002\t0'))), /Gid/);
});
test('rejects missing, duplicate, malformed, and inconsistent kernel IDs', () => {
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace(/^Uid:.*\n/m, ''))), /Uid/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean + 'Gid:\t12002\t12002\t12002\t12002\n')), /Gid/);
  assert.throws(() => assertNoBrokerCapabilities(options(clean.replace('Uid:\t12001\t12001\t12001\t12001', 'Uid:\t12001\tinvalid\t12001\t12001'))), /Uid/);
  assert.throws(() => assertNoBrokerCapabilities({ ...options(clean), credentials: () => ({ uid: 12001, euid: 0, gid: 12002, egid: 12002 }) }), /Uid/);
  assert.throws(() => assertNoBrokerCapabilities({ ...options(clean), credentials: () => { throw Error('unavailable'); } }), /Uid\/Gid/);
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
