import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolveSafeSubpath } from "./safe-path.js";

interface OwnershipRecord {
  version: 1;
  files: Record<string, string>;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOwnership(agentDir: string): Promise<OwnershipRecord> {
  const filename = resolveSafeSubpath(agentDir, "skillgate-owned.json");
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
  try {
    const existing = await lstat(manifestPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Unsafe ownership manifest");
    await writeFile(manifestPath, JSON.stringify(ownership, null, 2), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(manifestPath, JSON.stringify(ownership, null, 2), { encoding: "utf8", flag: "wx" });
  }
}
