/** Experimental read-only consumer for explicitly pinned broker generations.
 * No mutable "current" pointer, workspace materialization, or path operations.
 * A digest authenticates bytes, NOT who is authorized to select that digest.
 * This is not a strict lifecycle adapter or generation-selection authority.
 */
import { createHash } from 'node:crypto';
import { getBrokerBlob } from './immutable-broker-client.mjs';

const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const AGENT = /^[a-z][a-z0-9-]{0,63}$/;

function record(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys;
}

function logicalPath(path) {
  if (typeof path !== 'string' || path.length === 0 ||
      Buffer.byteLength(path, 'utf8') > 512 || path.includes('\\') ||
      path.includes('\0') || path.includes(':') || path.startsWith('/') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Unsafe pinned generation logical path');
  }
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error('Unsafe pinned generation logical path');
    }
  }
}

function authenticateBlob(bytes, digest) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BLOB_BYTES ||
      createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error('Pinned broker blob failed authentication');
  }
  return bytes;
}

/** Resolve only an externally trusted, explicit digest. The injected readBlob
 * must read by digest, never by mutable pathname; each result is rehashed.
 */
export async function resolvePinnedBrokerGeneration(readBlob, digest, expectedAgent) {
  if (typeof readBlob !== 'function' || typeof digest !== 'string' ||
      !DIGEST.test(digest) || typeof expectedAgent !== 'string' ||
      !AGENT.test(expectedAgent)) {
    throw new Error('Invalid pinned generation selection');
  }
  const raw = authenticateBlob(await readBlob(digest), digest);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new Error('Invalid pinned generation manifest');
  }
  if (!record(manifest, 'agent,files,kind,schemaVersion') ||
      manifest.schemaVersion !== '1' || manifest.agent !== expectedAgent ||
      (manifest.kind !== 'apply' && manifest.kind !== 'cleanup') ||
      !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES ||
      (manifest.kind === 'cleanup' && manifest.files.length !== 0)) {
    throw new Error('Invalid pinned generation manifest');
  }
  let previous = '';
  let total = 0;
  for (const entry of manifest.files) {
    if (!record(entry, 'digest,path,size') || typeof entry.path !== 'string' ||
        typeof entry.digest !== 'string' || !DIGEST.test(entry.digest) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        entry.size > MAX_BLOB_BYTES) {
      throw new Error('Invalid pinned generation file entry');
    }
    logicalPath(entry.path);
    if (previous && previous >= entry.path) {
      throw new Error('Pinned generation paths must be sorted and unique');
    }
    previous = entry.path;
    total += entry.size;
    if (total > MAX_BLOB_BYTES) {
      throw new Error('Pinned generation exceeds total byte limit');
    }
  }
  const files = new Map();
  // Multiple logical files may reference one content-addressed blob. Fetch it
  // once to conserve the authenticated proxy's strict per-minute request quota.
  const verifiedBlobs = new Map();
  for (const entry of manifest.files) {
    let bytes = verifiedBlobs.get(entry.digest);
    if (bytes === undefined) {
      bytes = authenticateBlob(await readBlob(entry.digest), entry.digest);
      verifiedBlobs.set(entry.digest, bytes);
    }
    if (bytes.length !== entry.size) {
      throw new Error('Pinned generation file size mismatch');
    }
    files.set(entry.path, Buffer.from(bytes));
  }
  return { generation: manifest, files };
}

/** Broker transport enforces socket ownership/ancestry and verifies blob SHA-256.
 * expectedBrokerUid/Gid must be pinned by a trusted administrator.
 */
export function readPinnedBrokerGeneration(socketPath, digest, expectedAgent, options) {
  return resolvePinnedBrokerGeneration(
    blobDigest => getBrokerBlob(socketPath, blobDigest, options), digest, expectedAgent);
}
