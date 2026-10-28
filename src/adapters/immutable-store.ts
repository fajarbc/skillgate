/** Experimental create-only blob store for P0 #28.
 *
 * This is NOT the adapter publication backend. The caller must place the store
 * outside independently writable workspace paths and protect its directory
 * ancestry from substitution. POSIX permissions cannot isolate a process
 * running under the same UID; that remains an explicit trust assumption.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export const MAX_IMMUTABLE_BLOB_BYTES = 32 * 1024 * 1024;

export interface ImmutableBlob {
  digest: string;
  path: string;
  created: boolean;
}

/** Require a pre-existing private store; never silently create it in workspace. */
async function assertPrivateStore(store: string): Promise<string> {
  if (typeof process.getuid !== "function" ||
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_NONBLOCK !== "number" ||
      typeof constants.O_DIRECTORY !== "number") {
    // Never silently drop the kernel protections against symlinks or FIFOs.
    // Unsupported platforms must fail closed before any staging I/O.
    throw new Error("SkillGate immutable store requires POSIX ownership and safe open flags");
  }
  const absolute = resolve(store);
  const root = parse(absolute).root;
  const chain: string[] = [];
  let cursor = absolute;
  while (cursor !== root) {
    chain.push(cursor);
    cursor = dirname(cursor);
  }
  for (const path of chain.reverse()) {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Unsafe SkillGate immutable store ancestry");
    }
    if (path === absolute) {
      if (entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
        throw new Error("SkillGate immutable store requires a private POSIX directory");
      }
    } else if ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) {
      // A writable non-sticky ancestor allows independent writers to replace
      // the store directory itself, bypassing the leaf directory permissions.
      throw new Error("Unsafe writable SkillGate immutable store ancestor");
    }
  }
  // Every subsequent filesystem operation must use this checked, normalized
  // absolute pathname. Using the original path would reintroduce symlink/..
  // traversal that lstat() of the normalized ancestry did not inspect.
  // This is still only preflight, not atomic protection against same-UID
  // adversaries or an attacker who can substitute an ancestor after checking.
  return absolute;
}

/** Verify the published entry using a bounded descriptor read, never a
 * pathname-based unbounded readFile(). Existing entries must be read-only.
 */
async function verifyBlob(path: string, digest: string, expectedSize?: number): Promise<Buffer> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_IMMUTABLE_BLOB_BYTES ||
        (expectedSize !== undefined && before.size !== expectedSize) ||
        (before.mode & 0o222) !== 0) {
      throw new Error("Immutable SkillGate blob collision or unsafe entry");
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      // One extra byte detects a file growing beyond the expected size.
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_IMMUTABLE_BLOB_BYTES + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_IMMUTABLE_BLOB_BYTES ||
          (expectedSize !== undefined && length > expectedSize)) {
        throw new Error("Immutable SkillGate blob collision or unsafe entry");
      }
      hash.update(chunk.subarray(0, bytesRead));
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if ((expectedSize !== undefined && length !== expectedSize) ||
        hash.digest("hex") !== digest ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        (after.mode & 0o222) !== 0) {
      throw new Error("Immutable SkillGate blob collision or unsafe entry");
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

/** Read and authenticate a pinned immutable digest; never interpret it as a path. */
export async function readImmutableBlob(store: string, digest: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid SkillGate blob digest");
  const safeStore = await assertPrivateStore(store);
  return verifyBlob(join(safeStore, digest), digest);
}

/** Publish bytes under their SHA-256 name without replacing any existing entry.
 *
 * This protects create-if-absent inside the trusted store; it does NOT provide
 * conditional replacement/removal of arbitrary workspace paths.
 */
export async function putImmutableBlob(store: string, bytes: Buffer): Promise<ImmutableBlob> {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new RangeError("SkillGate immutable blob exceeds the 32 MiB limit");
  }
  // Capture caller-owned bytes before the first await: callers may reuse or
  // mutate their Buffer while filesystem I/O is in progress.
  const snapshot = Buffer.from(bytes);
  const safeStore = await assertPrivateStore(store);
  const digest = createHash("sha256").update(snapshot).digest("hex");
  const destination = join(safeStore, digest);
  const temporary = join(safeStore, `.stage-${randomUUID()}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NOFOLLOW;
  const handle = await open(temporary, flags, 0o600);
  let created = false;
  try {
    try {
      await handle.writeFile(snapshot);
      // Read-only before publication: other cooperating readers cannot
      // observe a writable published inode.
      await handle.chmod(0o400);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verifyBlob(destination, digest, bytes.length);
    // Persist the new directory entry before reporting successful publication.
    if (created) {
      const directory = await open(safeStore, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { digest, path: destination, created };
  } finally {
    // Only unlink our staging entry, never the published digest path.
    await rm(temporary, { force: true });
  }
}
