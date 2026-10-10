import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { resolveSafeSubpath } from "./safe-path.js";

interface OwnershipRecord {
  version: 1;
  files: Record<string, string>;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertSafeParents(agentDir: string, path: string): Promise<void> {
  const root = resolve(agentDir);
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "" || rel.startsWith(sep)) {
    throw new Error(`Unsafe managed target: ${path}`);
  }
  let parent = dirname(target);
  while (parent !== root) {
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed parent: ${parent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    parent = dirname(parent);
  }
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe adapter directory: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readOwnership(agentDir: string): Promise<OwnershipRecord> {
  const filename = resolveSafeSubpath(agentDir, "skillgate-owned.json");
  await assertSafeParents(agentDir, filename);
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid ownership manifest");
    const data = raw as Record<string, unknown>;
    if (data.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) {
      throw new Error("invalid ownership manifest");
    }
    const files = data.files as Record<string, unknown>;
    if (Object.entries(files).some(([name, digest]) => !/^skills\/[a-z0-9.-]+\/SKILL\.md$|^skills\.json$/.test(name) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
      throw new Error("invalid ownership entries");
    }
    return { version: 1, files: files as Record<string, string> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, files: {} };
    throw error;
  }
}

/** Reject symlinked or non-directory adapter roots before any writes. */
export async function assertSafeAdapterDirectory(agentDir: string): Promise<void> {
  const root = resolve(agentDir);
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe adapter directory: ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Never follow a symlink in the workspace path leading to an adapter root. */
export async function assertSafeWorkspacePath(workspace: string): Promise<void> {
  let current = resolve(workspace);
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe workspace ancestor: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Serialize cooperative adapter writers using an exclusive lock file. */
export async function withManagedLock<T>(agentDir: string, operation: () => Promise<T>): Promise<T> {
  await assertSafeAdapterDirectory(agentDir);
  const lockPath = resolveSafeSubpath(agentDir, ".skillgate.lock");
  await assertSafeParents(agentDir, lockPath);
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Adapter directory is locked by another operation: ${agentDir}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    const owned = await handle.stat();
    await handle.close();
    try {
      const current = await lstat(lockPath);
      if (current.ino !== owned.ino || current.dev !== owned.dev || !current.isFile() || current.isSymbolicLink()) {
        throw new Error(`Adapter lock changed during operation: ${lockPath}`);
      }
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function checkManagedTargets(agentDir: string, targets: string[]): Promise<string[]> {
  const ownership = await readOwnership(agentDir);
  const journal = await readReplacementJournal(agentDir);
  const conflicts: string[] = [];
  for (const path of targets) {
    await assertSafeParents(agentDir, path);
    const relative = path.slice(agentDir.length + 1).replaceAll("\\", "/");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        conflicts.push(path);
        continue;
      }
      const currentHash = hash(await readFile(path, "utf8"));
      const replacement = journal.files[relative];
      const matchesJournal = replacement && replacement.previous === ownership.files[relative] && replacement.next === currentHash;
      if (ownership.files[relative] !== currentHash && !matchesJournal) conflicts.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Missing previously managed files are safe to recreate after interruption.
    }
  }
  return conflicts;
}

export async function recordManagedTargets(agentDir: string, targets: string[], expected: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
  const intended = new Map(expected.map((entry) => [resolve(entry.path), hash(entry.content)]));
  const ownership: OwnershipRecord = { version: 1, files: {} };
  for (const path of targets) {
    const relative = path.slice(agentDir.length + 1).replaceAll("\\", "/");
    await assertSafeParents(agentDir, path);
    const actual = hash(await readFile(path, "utf8"));
    if (actual !== intended.get(resolve(path))) {
      throw new Error(`Managed output changed before ownership commit: ${path}`);
    }
    ownership.files[relative] = actual;
  }
  await saveOwnership(agentDir, ownership);
}

/** Record the next digest before replacing a previously owned file.
 * Both old and next hashes are accepted during an interrupted replacement.
 */
interface ReplacementJournal { version: 1; files: Record<string, { previous: string; next: string }> }

async function readReplacementJournal(agentDir: string): Promise<ReplacementJournal> {
  const file = resolveSafeSubpath(agentDir, "skillgate-replacements.json");
  await assertSafeParents(agentDir, file);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe replacement journal");
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid replacement journal");
    const data = raw as Record<string, unknown>;
    if (data.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) {
      throw new Error("Invalid replacement journal");
    }
    const files = data.files as Record<string, unknown>;
    for (const [name, item] of Object.entries(files)) {
      if (!/^skills\/[a-z0-9.-]+\/SKILL\.md$|^skills\.json$/.test(name) ||
          !item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid replacement entry");
      const entry = item as Record<string, unknown>;
      if (typeof entry.previous !== "string" || !/^[a-f0-9]{64}$/.test(entry.previous) ||
          typeof entry.next !== "string" || !/^[a-f0-9]{64}$/.test(entry.next)) {
        throw new Error("Invalid replacement entry");
      }
    }
    return { version: 1, files: files as ReplacementJournal["files"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, files: {} };
    throw error;
  }
}

async function saveReplacementJournal(agentDir: string, journal: ReplacementJournal): Promise<void> {
  const file = resolveSafeSubpath(agentDir, "skillgate-replacements.json");
  await assertSafeParents(agentDir, file);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe replacement journal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = resolveSafeSubpath(agentDir, `.skillgate-replacements-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(journal, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await assertSafeParents(agentDir, file);
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function clearReplacementJournal(agentDir: string): Promise<void> {
  const file = resolveSafeSubpath(agentDir, "skillgate-replacements.json");
  await assertSafeParents(agentDir, file);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe replacement journal");
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Register intended output before publishing, so interrupted writes remain recoverable. */
export async function prepareManagedTargets(agentDir: string, entries: ReadonlyArray<{ path: string; content: string }>): Promise<void> {
  const current = await readOwnership(agentDir);
  const conflicts = await checkManagedTargets(agentDir, entries.map((entry) => entry.path));
  if (conflicts.length) throw new Error(`Refusing to overwrite existing adapter files: ${conflicts.join(", ")}`);
  for (const entry of entries) {
    await assertSafeParents(agentDir, entry.path);
    const key = relative(agentDir, entry.path).replaceAll("\\", "/");
    if (Object.hasOwn(current.files, key) && !/^[a-f0-9]{64}$/.test(current.files[key] ?? "")) throw new Error("Invalid ownership hash");
    if (!/^skills\/[a-z0-9.-]+\/SKILL\.md$|^skills\.json$/.test(key)) throw new Error(`Invalid managed target: ${entry.path}`);
    // Only publish the intended digest for previously absent targets.
    // Existing managed files retain their old digest until the replacement is published.
    try {
      await lstat(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current.files[key] = hash(entry.content);
    }
  }
  const journal = await readReplacementJournal(agentDir);
  for (const entry of entries) {
    const key = relative(agentDir, entry.path).replaceAll("\\", "/");
    const prior = current.files[key];
    if (!prior) continue;
    const next = hash(entry.content);
    if (prior === next) continue;
    const existing = journal.files[key];
    if (existing && (existing.previous !== prior || existing.next !== next)) {
      throw new Error(`Pending replacement differs from intended output: ${entry.path}`);
    }
    journal.files[key] = { previous: prior, next };
  }
  await saveReplacementJournal(agentDir, journal);
  await saveOwnership(agentDir, current);
}

async function saveOwnership(agentDir: string, ownership: OwnershipRecord): Promise<void> {
  const manifestPath = resolveSafeSubpath(agentDir, "skillgate-owned.json");
  await assertSafeParents(agentDir, manifestPath);
  try {
    const existing = await lstat(manifestPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = resolveSafeSubpath(agentDir, `.skillgate-owned-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(ownership, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await assertSafeParents(agentDir, manifestPath);
    await rename(temporary, manifestPath);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Stage a complete file and atomically publish it after rechecking ownership. */
export async function writeManagedTarget(agentDir: string, path: string, content: string): Promise<void> {
  await assertSafeParents(agentDir, path);
  const conflicts = await checkManagedTargets(agentDir, [path]);
  if (conflicts.length) throw new Error(`Refusing to overwrite existing adapter files: ${conflicts.join(", ")}`);
  const temporary = resolveSafeSubpath(dirname(path), `.skillgate-stage-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await assertSafeParents(agentDir, path);
    const latest = await checkManagedTargets(agentDir, [path]);
    if (latest.length) throw new Error(`Refusing to overwrite existing adapter files: ${latest.join(", ")}`);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Preview stale managed targets without touching user-owned files. */
export async function planStaleManagedTargets(agentDir: string, intended: string[]): Promise<{ filesToRemove: string[]; conflicts: string[] }> {
  const ownership = await readOwnership(agentDir);
  const expected = new Set(intended.map((path) => resolve(path)));
  const filesToRemove = Object.keys(ownership.files)
    .map((name) => resolveSafeSubpath(agentDir, name))
    .filter((path) => !expected.has(resolve(path)));
  const conflicts = await checkManagedTargets(agentDir, filesToRemove);
  return { filesToRemove, conflicts };
}

/** Remove stale owned files, refusing to remove modified or unowned files. */
export async function removeStaleManagedTargets(agentDir: string, intended: string[]): Promise<string[]> {
  const { filesToRemove, conflicts } = await planStaleManagedTargets(agentDir, intended);
  if (conflicts.length > 0) {
    throw new Error(`Refusing to remove modified managed files: ${conflicts.join(", ")}`);
  }
  const ownership = await readOwnership(agentDir);
  const removed: string[] = [];
  for (const path of filesToRemove) {
    await assertSafeParents(agentDir, path);
    const name = relative(agentDir, path).replaceAll("\\", "/");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(await readFile(path, "utf8")) !== ownership.files[name]) {
        throw new Error(`Managed file changed during cleanup: ${path}`);
      }
      await unlink(path);
      removed.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

/** Remove only files whose contents still match SkillGate's recorded hashes. */
export async function cleanupManagedTargets(agentDir: string): Promise<string[]> {
  const ownership = await readOwnership(agentDir);
  const journal = await readReplacementJournal(agentDir);
  if (Object.keys(journal.files).length > 0) {
    throw new Error("Refusing cleanup while a replacement transaction is pending; complete apply first");
  }
  const paths = Object.keys(ownership.files).map((name) => resolveSafeSubpath(agentDir, name));
  const conflicts = await checkManagedTargets(agentDir, paths);
  if (conflicts.length > 0) {
    throw new Error(`Refusing to remove modified managed files: ${conflicts.join(", ")}`);
  }
  const removed: string[] = [];
  for (const path of paths) {
    await assertSafeParents(agentDir, path);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe managed file: ${path}`);
    const relative = path.slice(agentDir.length + 1).replaceAll("\\", "/");
    if (hash(await readFile(path, "utf8")) !== ownership.files[relative]) {
      throw new Error(`Managed file changed during cleanup: ${path}`);
    }
    await unlink(path);
    removed.push(path);
  }
  const manifestPath = resolveSafeSubpath(agentDir, "skillgate-owned.json");
  await assertSafeParents(agentDir, manifestPath);
  try {
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
    await unlink(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return removed;
}
