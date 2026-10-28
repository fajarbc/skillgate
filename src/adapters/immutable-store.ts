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
import { join } from "node:path";

export const MAX_IMMUTABLE_BLOB_BYTES = 32 * 1024 * 1024;

export interface ImmutableBlob {
  digest: string;
  path: string;
  created: boolean;
}

/** Require a pre-existing private store; never silently create it in workspace. */
async function assertPrivateStore(store: string): Promise<void> {
  const entry = await lstat(store);
  if (typeof process.getuid !== "function" || !entry.isDirectory() ||
      entry.isSymbolicLink() || entry.uid !== process.getuid() ||
      (entry.mode & 0o077) !== 0) {
    throw new Error("SkillGate immutable store requires a private POSIX directory");
  }
}

/** Verify the published entry using a bounded descriptor read, never a
 * pathname-based unbounded readFile(). Existing entries must be read-only.
 */
async function verifyBlob(path: string, digest: string, expectedSize: number): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedSize ||
        (before.mode & 0o222) !== 0) {
      throw new Error("Immutable SkillGate blob collision or unsafe entry");
    }
    const hash = createHash("sha256");
    let length = 0;
    while (true) {
      // One extra byte detects a file growing beyond the expected size.
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > expectedSize) {
        throw new Error("Immutable SkillGate blob collision or unsafe entry");
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (length !== expectedSize || hash.digest("hex") !== digest ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        (after.mode & 0o222) !== 0) {
      throw new Error("Immutable SkillGate blob collision or unsafe entry");
    }
  } finally {
    await handle.close();
  }
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
  await assertPrivateStore(store);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const destination = join(store, digest);
  const temporary = join(store, `.stage-${randomUUID()}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, 0o600);
  let created = false;
  try {
    try {
      await handle.writeFile(bytes);
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
      const directory = await open(store, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
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
