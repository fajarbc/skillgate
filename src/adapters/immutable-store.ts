/** Experimental append-only layout primitive for lifecycle issue #28.
 * This does not publish, replace, or delete adapter-visible paths. The caller
 * must provide a pre-established, access-controlled store directory; untrusted
 * writers with directory write permission defeat this trust boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface ImmutableBlob {
  digest: string;
  path: string;
  created: boolean;
}

/** Store immutable bytes by digest using create-if-absent hard linking.
 * No existing directory entry is replaced, even when a competing creator wins.
 * Do not use this in a directory writable by arbitrary concurrent writers.
 */
export async function putImmutableBlob(store: string, bytes: Buffer): Promise<ImmutableBlob> {
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
    // A colliding entry must not be accepted merely because its name matches.
    // The store directory is assumed private; checks are not an atomic defense
    // against a writer allowed to replace the entry after verification.
    const entry = await lstat(destination);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== bytes.length ||
        createHash("sha256").update(await readFile(destination)).digest("hex") !== digest) {
      throw new Error("Immutable SkillGate blob collision or unsafe entry");
    }
    return { digest, path: destination, created };
  } finally {
    // Only remove our unpredictable staging entry, never the published blob.
    await rm(temporary, { force: true });
  }
}
