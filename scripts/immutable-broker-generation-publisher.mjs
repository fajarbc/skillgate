/** Experimental immutable generation publisher over the authenticated broker.
 *
 * This creates content-addressed blobs only. It does NOT authorize a digest,
 * change the root-owned generation selector, or implement strict apply/cleanup.
 * An administrator must independently approve and select a published digest.
 */
import { createHash } from 'node:crypto';
import { putBrokerBlob } from './immutable-broker-client.mjs';

const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 256;
const AGENT = /^[a-z][a-z0-9-]{0,63}$/;

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function assertLogicalPath(path) {
  if (typeof path !== 'string' || path.length === 0 ||
      Buffer.byteLength(path, 'utf8') > 512 || path.includes('\\') ||
      path.includes('\0') || path.includes(':') || path.startsWith('/') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Unsafe immutable broker generation logical path');
  }
  for (const character of path) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error('Unsafe immutable broker generation logical path');
    }
  }
}

/** Synchronously validate and snapshot everything before any broker I/O.
 * Uses the same canonical manifest layout as publishImmutableGeneration().
 */
export function prepareBrokerGeneration(agent, kind, files) {
  if (typeof agent !== 'string' || !AGENT.test(agent) ||
      (kind !== 'apply' && kind !== 'cleanup') || !(files instanceof Map) ||
      files.size > MAX_FILES || (kind === 'cleanup' && files.size !== 0)) {
    throw new Error('Invalid immutable broker generation input');
  }
  const snapshots = [];
  let total = 0;
  for (const [path, bytes] of files) {
    // Validate actual iterator output, not only the caller-overridable size.
    if (snapshots.length >= MAX_FILES || kind === 'cleanup') {
      throw new Error('Invalid immutable broker generation file count');
    }
    assertLogicalPath(path);
    if (!Buffer.isBuffer(bytes)) throw new Error('Immutable broker generation content must be a Buffer');
    total += bytes.length;
    if (total > MAX_BLOB_BYTES) throw new Error('Immutable broker generation exceeds total byte limit');
    snapshots.push([path, Buffer.from(bytes)]);
  }
  snapshots.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i - 1][0] === snapshots[i][0]) {
      throw new Error('Duplicate immutable broker generation logical path');
    }
  }
  const generation = {
    schemaVersion: '1', agent, kind,
    files: snapshots.map(([path, bytes]) => ({ path, digest: digest(bytes), size: bytes.length })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(generation), 'utf8');
  if (manifestBytes.length > MAX_BLOB_BYTES) {
    throw new Error('Immutable broker generation manifest exceeds byte limit');
  }
  return { digest: digest(manifestBytes), generation, manifestBytes, snapshots };
}

/** Injected transport for deterministic tests. No selector or workspace writes.
 * A failed content publication never publishes a generation manifest.
 */
export async function publishBrokerGenerationWith(putBlob, agent, kind, files) {
  if (typeof putBlob !== 'function') throw new Error('Invalid immutable broker publisher');
  const prepared = prepareBrokerGeneration(agent, kind, files);
  // Identical logical files share one content-addressed blob. Repeated PUTs
  // consume the authenticated proxy's limited request quota without creating
  // new content; authenticate each unique acknowledgement before skipping it.
  const publishedDigests = new Set();
  for (const [index, [, bytes]] of prepared.snapshots.entries()) {
    const expectedDigest = prepared.generation.files[index].digest;
    if (publishedDigests.has(expectedDigest)) continue;
    const published = await putBlob(bytes);
    if (published?.digest !== expectedDigest) {
      throw new Error('Immutable broker generation content acknowledgement mismatch');
    }
    publishedDigests.add(expectedDigest);
  }
  const manifest = await putBlob(prepared.manifestBytes);
  if (manifest?.digest !== prepared.digest) {
    throw new Error('Immutable broker generation manifest acknowledgement mismatch');
  }
  return { digest: prepared.digest, generation: prepared.generation };
}

/** Production transport; broker identity must be pinned by trusted config.
 * Publication does not grant selection authority to this client UID.
 */
export function publishBrokerGeneration(socketPath, agent, kind, files, options) {
  return publishBrokerGenerationWith(
    bytes => putBrokerBlob(socketPath, bytes, options), agent, kind, files);
}
