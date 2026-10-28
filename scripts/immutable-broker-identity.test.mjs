import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertDedicatedBrokerIdentity } from './immutable-broker-identity.mjs';

const identity = (overrides = {}) => ({
  getuid: () => 20001,
  geteuid: () => 20001,
  getgid: () => 20002,
  getegid: () => 20002,
  getgroups: () => [20002],
  ...overrides,
});

describe('immutable broker process identity', () => {
  it('accepts a dedicated non-root identity', () => {
    assert.deepEqual(assertDedicatedBrokerIdentity(identity()), { uid: 20001, gid: 20002 });
  });
  it('rejects real root even with a non-root effective UID', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ getuid: () => 0 })), /non-root/);
  });
  it('rejects effective root even with a non-root real UID', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ geteuid: () => 0 })), /non-root/);
  });
  it('rejects mismatched real and effective UIDs', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ geteuid: () => 20003 })), /credentials/);
  });
  it('rejects mismatched real and effective GIDs', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ getegid: () => 20003 })), /credentials/);
  });
  it('rejects root primary and supplementary groups', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ getgid: () => 0, getegid: () => 0 })), /non-root/);
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ getgroups: () => [0, 20002] })), /root/);
  });
  it('fails closed when credential inspection is unavailable or malformed', () => {
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ geteuid: undefined })), /inspection/);
    assert.throws(() => assertDedicatedBrokerIdentity(identity({ getgroups: () => ['0'] })), /credentials/);
  });
});
