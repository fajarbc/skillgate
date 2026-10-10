import { createHash } from "node:crypto";
import { lstat, readFile, unlink, writeFile } from "node:fs/promises";
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

export async function checkManagedTargets(agentDir: string, targets: string[]): Promise<string[]> {
  const ownership = await readOwnership(agentDir);
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
      if (ownership.files[relative] !== currentHash) conflicts.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (ownership.files[relative]) conflicts.push(path);
    }
  }
  return conflicts;
}

export async function recordManagedTargets(agentDir: string, targets: string[]): Promise<void> {
  const ownership = await readOwnership(agentDir);
  for (const path of targets) {
    const relative = path.slice(agentDir.length + 1).replaceAll("\\", "/");
    ownership.files[relative] = hash(await readFile(path, "utf8"));
  }
  const manifestPath = resolveSafeSubpath(agentDir, "skillgate-owned.json");
  await assertSafeParents(agentDir, manifestPath);
  try {
    const existing = await lstat(manifestPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
    await writeFile(manifestPath, JSON.stringify(ownership, null, 2), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(manifestPath, JSON.stringify(ownership, null, 2), { encoding: "utf8", flag: "wx" });
  }
}

/** Remove only files whose contents still match SkillGate's recorded hashes. */
export async function cleanupManagedTargets(agentDir: string): Promise<string[]> {
  const ownership = await readOwnership(agentDir);
  const paths = Object.keys(ownership.files).map((name) => resolveSafeSubpath(agentDir, name));
  const conflicts = await checkManagedTargets(agentDir, paths);
  if (conflicts.length > 0) {
    throw new Error(`Refusing to remove modified managed files: ${conflicts.join(", ")}`);
  }
  const removed: string[] = [];
  for (const path of paths) {
    await assertSafeParents(agentDir, path);
    const stat = await lstat(path);
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
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
  await unlink(manifestPath);
  return removed;
}
