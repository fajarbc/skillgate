/** Experimental POSIX append-only blob broker for SkillGate P0 #28.
 *
 * Run under a dedicated OS UID, different from every untrusted workspace writer.
 * The socket parent must be broker-owned and not writable by clients. A socket
 * group grants access to all members; this protocol does not authenticate an
 * individual caller or authorize generation selection. NOT strict integration.
 *
 * Usage: SKILLGATE_BROKER_CLIENT_UID=<untrusted-uid> \
 *   SKILLGATE_BROKER_CLIENT_GID=<client-group-gid> \
 *   node scripts/immutable-store-broker.mjs <socket-path> <store-path>
 */
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { putImmutableBlob, readImmutableBlob, MAX_IMMUTABLE_BLOB_BYTES } from
  '../dist/adapters/immutable-store.js';

const MAX_WIRE_BYTES = 4 * Math.ceil(MAX_IMMUTABLE_BLOB_BYTES / 3) + 2048;
const MAX_CONNECTIONS = 1;
const IDLE_TIMEOUT_MS = 15000;
// An idle timeout alone is vulnerable to a peer sending one byte periodically.
const MAX_CONNECTION_LIFETIME_MS = 15000;

function usageError(message) {
  throw new Error('Immutable broker configuration: ' + message);
}

async function checkProtectedParent(path) {
  const parent = dirname(path);
  const root = parse(parent).root;
  const chain = [];
  for (let cursor = parent; cursor !== root; cursor = dirname(cursor)) {
    chain.push(cursor);
  }
  chain.push(root);
  for (const entryPath of chain.reverse()) {
    const entry = await lstat(entryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      usageError('socket ancestry must be real directories');
    }
    if (entry.uid !== 0 && entry.uid !== process.getuid()) {
      usageError('socket ancestor is owned by an untrusted UID');
    }
    if (entryPath === parent) {
      if (entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0) {
        usageError('socket parent must be broker-owned and not group/world writable');
      }
    } else if ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) {
      usageError('socket ancestor is writable without sticky protection');
    }
  }
}

function decodeRequest(line) {
  let request;
  try { request = JSON.parse(line); } catch { throw new Error('invalid JSON'); }
  if (request === null || typeof request !== 'object' || Array.isArray(request) ||
      request.v !== 1 || typeof request.op !== 'string') {
    throw new Error('invalid broker request');
  }
  if (request.op === 'put' && Object.keys(request).sort().join(',') === 'bytes,op,v' &&
      typeof request.bytes === 'string') {
    const encoded = request.bytes;
    if (encoded.length > 4 * Math.ceil(MAX_IMMUTABLE_BLOB_BYTES / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('invalid blob encoding');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_IMMUTABLE_BLOB_BYTES || bytes.toString('base64') !== encoded) {
      throw new Error('invalid blob encoding');
    }
    return { op: 'put', bytes };
  }
  if (request.op === 'get' && Object.keys(request).sort().join(',') === 'digest,op,v' &&
      typeof request.digest === 'string' && /^[a-f0-9]{64}$/.test(request.digest)) {
    return { op: 'get', digest: request.digest };
  }
  throw new Error('unsupported broker request');
}

async function main() {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' ||
      typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
    usageError('requires POSIX ownership and safe open flags');
  }
  if (process.getuid() === 0) usageError('run as a dedicated non-root service UID');
  const clientUid = process.env.SKILLGATE_BROKER_CLIENT_UID;
  if (!/^(0|[1-9][0-9]*)$/.test(clientUid ?? '') ||
      !Number.isSafeInteger(Number(clientUid)) || Number(clientUid) === 0 ||
      Number(clientUid) === process.getuid()) {
    usageError('a distinct expected client UID is required');
  }
  // The socket group is the protocol's only access-control boundary.
  // Require an explicit non-root group and verify the process will create
  // the socket with that group, rather than silently using a service default.
  const clientGid = process.env.SKILLGATE_BROKER_CLIENT_GID;
  if (typeof process.getegid !== 'function' ||
      !/^[1-9][0-9]*$/.test(clientGid ?? '') ||
      !Number.isSafeInteger(Number(clientGid)) ||
      Number(clientGid) !== process.getegid()) {
    usageError('an explicit non-root socket client GID matching the effective service GID is required');
  }
  if (process.argv.length !== 4 || !process.argv[2] || !process.argv[3] ||
      !isAbsolute(process.argv[2]) || !isAbsolute(process.argv[3])) {
    usageError('expected absolute socket and store paths');
  }
  const socketPath = resolve(process.argv[2]);
  const store = resolve(process.argv[3]);
  await checkProtectedParent(socketPath);
  try {
    await lstat(socketPath);
    usageError('socket path already exists; refusing to unlink it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Fail before accepting clients if the store is not usable by this UID.
  await checkProtectedParent(resolve(store, '.skillgate-ancestry-probe'));
  const storeEntry = await lstat(store);
  if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink() ||
      storeEntry.uid !== process.getuid() || (storeEntry.mode & 0o077) !== 0) {
    usageError('store must be a broker-owned 0700 directory');
  }

  // The socket is created with group read/write only, never world access.
  process.umask(0o117);
  let active = 0;
  let ready = false;
  const server = createServer({ pauseOnConnect: true }, socket => {
    if (!ready || active >= MAX_CONNECTIONS) { socket.destroy(); return; }
    active++;
    let done = false;
    let processing = false;
    let closed = false;
    let released = false;
    const release = () => {
      if (closed && !processing && !released) { active--; released = true; }
    };
    let chunks = [];
    let size = 0;
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    // Absolute lifetime also bounds slow-drip clients that never go idle.
    const lifetime = setTimeout(() => socket.destroy(), MAX_CONNECTION_LIFETIME_MS);
    lifetime.unref();
    socket.once('close', () => {
      clearTimeout(lifetime);
      closed = true; chunks = []; release();
    });
    // A completed response no longer occupies the in-flight operation slot.
    // The peer may still be closing its socket when it opens the next one.
    socket.once('finish', () => { closed = true; release(); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_WIRE_BYTES) { done = true; socket.destroy(); return; }
      const newline = chunk.indexOf(10);
      if (newline !== -1) {
        done = true;
        processing = true;
        if (newline !== chunk.length - 1) {
          processing = false;
          socket.destroy();
          return;
        }
        chunks.push(chunk.subarray(0, newline));
        let line;
        try {
          line = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          processing = false;
          socket.destroy();
          return;
        }
        chunks = [];
        void (async () => {
          try {
            const request = decodeRequest(line);
            if (request.op === 'put') {
              const { digest, created } = await putImmutableBlob(store, request.bytes);
              socket.end(JSON.stringify({ v: 1, ok: true, digest, created }) + '\n');
            } else {
              const bytes = await readImmutableBlob(store, request.digest);
              socket.end(JSON.stringify({ v: 1, ok: true, bytes: bytes.toString('base64') }) + '\n');
            }
          } catch {
            // Do not leak private store paths or filesystem errors to clients.
            socket.end('{"v":1,"ok":false,"error":"request rejected"}\n');
          } finally {
            processing = false;
            release();
          }
        })();
      } else {
        chunks.push(chunk);
      }
    });
    socket.resume();
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(socketPath, () => { server.off('error', fail); ok(); });
  });
  const socketEntry = await stat(socketPath);
  if (!socketEntry.isSocket() || socketEntry.uid !== process.getuid() ||
      socketEntry.gid !== Number(clientGid) ||
      (socketEntry.mode & 0o777) !== 0o660) {
    server.close();
    usageError('socket permissions are not group-only');
  }
  ready = true;
  console.error('SkillGate experimental immutable broker listening');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
