/** Experimental root-controlled selection of a pinned immutable generation.
 * This is a read-only trust anchor, NOT strict lifecycle integration. The
 * administrator must pin the selection pathname outside untrusted workspaces.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

const MAX_SELECTION_BYTES = 192;
const AGENT = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function invalid() { throw new Error('Untrusted immutable generation selection'); }

function safePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) ||
      path.startsWith('//') || path === parse(path).root ||
      resolve(path) !== path || path.includes('\0')) invalid();
}

async function checkTrustedAncestors(path) {
  const root = parse(path).root;
  const chain = [];
  for (let cursor = dirname(path); cursor !== root; cursor = dirname(cursor)) {
    chain.push(cursor);
  }
  chain.push(root);
  for (const part of chain.reverse()) {
    const st = await lstat(part);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 ||
        ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)) invalid();
  }
}

function trustedSelectionFile(st) {
  return st.isFile() && !st.isSymbolicLink() && st.uid === 0 &&
    st.nlink === 1 && (st.mode & 0o022) === 0 &&
    st.size > 0 && st.size <= MAX_SELECTION_BYTES;
}

/** Read no more than MAX_SELECTION_BYTES + 1 from a pinned descriptor.
 * The extra byte catches concurrent growth even if metadata timestamps have
 * insufficient resolution. Exported for deterministic short-read/race tests.
 */
export async function readBoundedSelectionBytes(handle, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 ||
      expectedSize > MAX_SELECTION_BYTES) invalid();
  const bytes = Buffer.alloc(MAX_SELECTION_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length !== expectedSize) invalid();
  return bytes.subarray(0, length);
}

/** Read a root-owned selector file, not a caller-controlled mutable pointer.
 * The caller MUST pin selectionPath through administrator-controlled config.
 * The returned digest still requires a trusted authorization decision.
 */
export async function readTrustedGenerationSelection(selectionPath, expectedAgent) {
  safePath(selectionPath);
  if (typeof expectedAgent !== 'string' || !AGENT.test(expectedAgent) ||
      typeof constants.O_NOFOLLOW !== 'number' ||
      typeof constants.O_NONBLOCK !== 'number') invalid();
  await checkTrustedAncestors(selectionPath);
  const handle = await open(selectionPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const entry = await lstat(selectionPath);
    if (!trustedSelectionFile(before) || !trustedSelectionFile(entry) ||
        before.dev !== entry.dev || before.ino !== entry.ino) invalid();
    // A root-controlled selector can still be rewritten by an administrator
    // while this read is pending. Never use readFile() after a size preflight:
    // it can allocate without a bound if the file grows concurrently.
    const bytes = await readBoundedSelectionBytes(handle, before.size);
    const after = await handle.stat();
    if (bytes.length !== before.size || bytes.length > MAX_SELECTION_BYTES ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || !trustedSelectionFile(after)) invalid();
    if (bytes.some(byte => byte > 0x7f)) invalid();
    const text = bytes.toString('ascii');
    const match = /^skillgate-generation-v1 ([a-z][a-z0-9-]{0,63}) ([a-f0-9]{64})\n$/.exec(text);
    if (!match || match[1] !== expectedAgent || !DIGEST.test(match[2])) invalid();
    return match[2];
  } finally {
    await handle.close();
  }
}
