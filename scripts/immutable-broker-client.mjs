/** Experimental authenticated client for the P0 #28 immutable blob broker.
 *
 * This is not a strict lifecycle adapter and does not select trusted generations.
 * The caller must use a protected broker socket configured by its administrator.
 */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';

const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_GET_RESPONSE_BYTES = 4 * Math.ceil(MAX_BLOB_BYTES / 3) + 2048;
const MAX_PUT_RESPONSE_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 15000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function validateSocketPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Immutable broker requires an absolute socket path');
  }
}

function decodeBase64(encoded) {
  if (typeof encoded !== 'string' ||
      encoded.length > 4 * Math.ceil(MAX_BLOB_BYTES / 3) ||
      !BASE64_PATTERN.test(encoded)) {
    throw new Error('Invalid immutable broker blob encoding');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_BLOB_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('Invalid immutable broker blob encoding');
  }
  return bytes;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys;
}

async function exchange(socketPath, request, maxResponseBytes, timeoutMs) {
  validateSocketPath(socketPath);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new Error('Invalid immutable broker client timeout');
  }
  const wire = Buffer.from(JSON.stringify(request) + '\n', 'utf8');
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks = [];
    let size = 0;
    let settled = false;
    const deadline = setTimeout(() => fail(new Error('Immutable broker response timeout')), timeoutMs);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      reject(error);
    };
    socket.on('error', fail);
    // The broker replies after reading the newline. Do not half-close here:
    // Node servers without allowHalfOpen may close before async put/get finishes.
    socket.on('connect', () => socket.write(wire));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxResponseBytes) {
        fail(new Error('Immutable broker response exceeds byte limit'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (settled) return;
      const bytes = Buffer.concat(chunks, size);
      if (bytes.length === 0 || bytes[bytes.length - 1] !== 10 ||
          bytes.subarray(0, bytes.length - 1).includes(10)) {
        fail(new Error('Invalid immutable broker response framing'));
        return;
      }
      let response;
      try {
        response = JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(bytes.subarray(0, bytes.length - 1)));
      } catch {
        fail(new Error('Invalid immutable broker response JSON'));
        return;
      }
      if (exactKeys(response, 'error,ok,v') && response.v === 1 &&
          response.ok === false && response.error === 'request rejected') {
        fail(new Error('Immutable broker request rejected'));
        return;
      }
      if (response?.v !== 1 || response?.ok !== true) {
        fail(new Error('Invalid immutable broker response envelope'));
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(response);
    });
    socket.on('close', () => {
      if (!settled) fail(new Error('Immutable broker connection closed prematurely'));
    });
  });
}

/** Publish a snapshotted blob; never trust a broker's returned digest blindly. */
export async function putBrokerBlob(socketPath, bytes, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BLOB_BYTES) {
    throw new RangeError('Immutable broker blob must be a Buffer of at most 32 MiB');
  }
  const snapshot = Buffer.from(bytes);
  const digest = createHash('sha256').update(snapshot).digest('hex');
  const response = await exchange(socketPath,
    { v: 1, op: 'put', bytes: snapshot.toString('base64') },
    MAX_PUT_RESPONSE_BYTES, timeoutMs);
  if (!exactKeys(response, 'created,digest,ok,v') ||
      response.digest !== digest || typeof response.created !== 'boolean') {
    throw new Error('Immutable broker publication response failed authentication');
  }
  return { digest, created: response.created };
}

/** Read only by SHA-256 digest; verify returned bytes independently of the broker. */
export async function getBrokerBlob(socketPath, digest, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new Error('Invalid immutable broker digest');
  }
  const response = await exchange(socketPath, { v: 1, op: 'get', digest },
    MAX_GET_RESPONSE_BYTES, timeoutMs);
  if (!exactKeys(response, 'bytes,ok,v')) {
    throw new Error('Invalid immutable broker retrieval response');
  }
  const bytes = decodeBase64(response.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error('Immutable broker retrieval digest mismatch');
  }
  return bytes;
}
