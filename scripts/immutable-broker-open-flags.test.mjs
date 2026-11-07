import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBrokerSafeOpenFlags } from './immutable-broker-open-flags.mjs';

const valid = { O_NOFOLLOW: 1, O_DIRECTORY: 2, O_NONBLOCK: 4 };
test('broker accepts Linux with required nonzero kernel open flags', () => {
  assert.doesNotThrow(() => assertBrokerSafeOpenFlags({ platform: 'linux', flags: valid }));
});
for (const platform of ['win32', 'darwin', 'freebsd']) {
  test(`broker rejects unsupported ${platform}`, () => {
    assert.throws(() => assertBrokerSafeOpenFlags({ platform, flags: valid }), /requires Linux/);
  });
}
for (const name of Object.keys(valid)) {
  for (const value of [undefined, null, 0, -1, NaN, '4']) {
    test(`broker rejects ${name}=${String(value)}`, () => {
      assert.throws(() => assertBrokerSafeOpenFlags({
        platform: 'linux', flags: { ...valid, [name]: value },
      }), /requires Linux/);
    });
  }
}
test('broker checks real Node open flags', () => {
  if (process.platform === 'linux') assert.doesNotThrow(() => assertBrokerSafeOpenFlags());
  else assert.throws(() => assertBrokerSafeOpenFlags(), /requires Linux/);
});
