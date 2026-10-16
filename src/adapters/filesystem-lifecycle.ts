import { access, lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { prepareSafeSkillPaths, resolveSafeSubpath } from "./safe-path.js";
import type {
  AdapterContext,
  AdapterPlan,
  AdapterResult,
  CleanupResult,
  LifecycleOptions,
} from "./types.js";

export const OWNERSHIP_HEADER = "<!-- Managed by SkillGate. Do not edit directly. -->\n";

export interface ManifestData {
  managedBy: "skillgate";
  version: "1.0";
  agent: string;
  task: string;
  updatedAt: string;
  managedFiles: string[];
  /** SHA-256 of managed skill file bytes; missing entries support older manifests. */
  fileDigests?: Record<string, string>;
  skills: Array<{
    name: string;
    identifier: string;
    description: string;
    path: string;
    score: number;
    capabilities: string[];
  }>;
}

export class AdapterConflictError extends Error {
  constructor(public readonly conflictingFiles: string[]) {
    super(
      `Destination contains user-owned content: ${conflictingFiles.join(", ")}. Use force option to overwrite.`,
    );
    this.name = "AdapterConflictError";
  }
}

export async function readPreviousManifest(manifestPath: string, expectedAgent?: string): Promise<ManifestData | null> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.managedBy === "skillgate" && parsed.version === "1.0" &&
      typeof parsed.agent === "string" && parsed.agent.length > 0 &&
      (!expectedAgent || parsed.agent === expectedAgent) &&
      Array.isArray(parsed.managedFiles) &&
      parsed.managedFiles.every((file: unknown) => typeof file === "string")) {
      return parsed as ManifestData;
    }
    return null;
  } catch {
    return null;
  }
}

/** Never trust deletion targets copied from an on-disk manifest. */
function isSafeManagedFilePath(agentRoot: string, filePath: string): boolean {
  if (!isAbsolute(filePath)) return false;
  const root = resolve(agentRoot);
  const target = resolve(filePath);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return false;
  if (rel === "skills.json") return true;
  const segments = rel.split(sep);
  return segments.length === 3 && segments[0] === "skills" &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(segments[1] ?? "") &&
    segments[2] === "SKILL.md";
}

/** Reject symlinks in managed directories and their existing ancestors. */
async function assertNoSymlinkAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Unsafe symlinked adapter path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Stage complete bytes before replacing a managed destination. */
async function writeManagedFile(path: string, content: string, options?: { force?: boolean; manifest?: boolean; agent?: string }): Promise<void> {
  await assertNoSymlinkAncestors(path);
  const temporaryPath = join(dirname(path), `.skillgate-${randomUUID()}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  try {
    const handle = await open(temporaryPath, flags, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertNoSymlinkAncestors(path);
    if (await fileExists(path) && !options?.force) {
      const owned = options?.manifest ? (await readPreviousManifest(path, options.agent)) !== null : await isManagedFile(path, null);
      if (!owned) throw new AdapterConflictError([path]);
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function isManagedFile(
  filePath: string,
  previousManifest: ManifestData | null,
): Promise<boolean> {
    try {
    const content = await readFile(filePath, "utf8");
    return content.startsWith(OWNERSHIP_HEADER) &&
      (previousManifest === null || (previousManifest.managedFiles.includes(filePath) &&
        (!previousManifest.fileDigests?.[filePath] || previousManifest.fileDigests[filePath] === digest(content))));
  } catch {
    return false;
  }
}

export async function planFilesystemAdapter(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<AdapterPlan> {
  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  const skillsDir = resolveSafeSubpath(agentRoot, "skills");
  const manifestPath = resolveSafeSubpath(agentRoot, "skills.json");

  await assertNoSymlinkAncestors(manifestPath);
  await assertNoSymlinkAncestors(skillsDir);
  const previousManifest = await readPreviousManifest(manifestPath, agentName);
  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);

  const plannedWrites: string[] = [];
  const conflicts: string[] = [];

  for (const { dirPath } of preparedSkills) {
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");
    plannedWrites.push(destFile);
    await assertNoSymlinkAncestors(destFile);

    if (await fileExists(destFile)) {
      // A manifest entry alone is not proof that the current bytes are ours.
      const managed = await isManagedFile(destFile, previousManifest);
      if (!managed && !options?.force) {
        conflicts.push(destFile);
      }
    }
  }

  plannedWrites.push(manifestPath);
  if (await fileExists(manifestPath)) {
    if (!previousManifest && !options?.force) {
      conflicts.push(manifestPath);
    }
  }

  const plannedRemovals: string[] = [];
  if (previousManifest) {
    for (const prevFile of previousManifest.managedFiles) {
      if (isSafeManagedFilePath(agentRoot, prevFile) && prevFile !== manifestPath && !plannedWrites.includes(prevFile)) {
        await assertNoSymlinkAncestors(prevFile);
        // Do not schedule a stale file for deletion if its managed marker
        // was removed or altered after the previous apply.
        if (await fileExists(prevFile) && await isManagedFile(prevFile, previousManifest)) {
          plannedRemovals.push(prevFile);
        }
      }
    }
  }

  const exposedSkills = preparedSkills.map((s) => s.skill.metadata.name);

  return {
    agent: agentName,
    writes: plannedWrites,
    removals: plannedRemovals,
    conflicts,
    skills: exposedSkills,
    summary: `Plan for ${agentName}: ${plannedWrites.length} write(s), ${plannedRemovals.length} removal(s)${conflicts.length > 0 ? `, ${conflicts.length} conflict(s)` : ""}`,
  };
}

export async function applyFilesystemAdapter(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<AdapterResult> {
  const plan = await planFilesystemAdapter(agentName, managedDirName, context, options);

  if (plan.conflicts.length > 0 && !options?.force) {
    throw new AdapterConflictError(plan.conflicts);
  }

  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  const skillsDir = resolveSafeSubpath(agentRoot, "skills");
  const manifestPath = resolveSafeSubpath(agentRoot, "skills.json");

  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);
  // Read every source before creating directories or changing managed files.
  // A missing or unreadable later source must not leave a partial apply.
  const preparedContents = await Promise.all(preparedSkills.map(async ({ skill }) => {
    try {
      return await readFile(skill.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return `---\nname: ${skill.metadata.name}\ndescription: ${skill.metadata.description}\n---\n`;
    }
  }));

  // Persist intended ownership before mutating skill files so cleanup can
  // recover files from an interrupted apply.
  await assertNoSymlinkAncestors(manifestPath);
  await mkdir(agentRoot, { recursive: true });
  const prior = await readPreviousManifest(manifestPath, agentName);
  const pending: ManifestData = {
    managedBy: "skillgate", version: "1.0", agent: agentName,
    task: context.task, updatedAt: new Date().toISOString(),
    managedFiles: [...new Set([
      ...(prior?.managedFiles ?? []).filter((p) => isSafeManagedFilePath(agentRoot, p)),
      ...preparedSkills.map(({ dirPath }) => resolveSafeSubpath(dirPath, "SKILL.md")),
      manifestPath,
    ])],
    fileDigests: { ...(prior?.fileDigests ?? {}) },
    skills: preparedSkills.map(({ skill, safeId }) => ({
      name: skill.metadata.name, identifier: safeId,
      description: skill.metadata.description, path: skill.path,
      score: skill.score, capabilities: skill.metadata.capabilities ?? [],
    })),
  };
  await writeManagedFile(manifestPath, JSON.stringify(pending, null, 2), {
    force: options?.force, manifest: true, agent: agentName,
  });
  await assertNoSymlinkAncestors(skillsDir);
  await mkdir(skillsDir, { recursive: true });
  const filesWritten: string[] = [];
  const fileDigests: Record<string, string> = { ...(prior?.fileDigests ?? {}) };

  for (const { skill, dirPath } of preparedSkills) {
    await assertNoSymlinkAncestors(dirPath);
    await mkdir(dirPath, { recursive: true });
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");

    const contentToWrite = `${OWNERSHIP_HEADER}${preparedContents[filesWritten.length]}`;
    await writeManagedFile(destFile, contentToWrite, { force: options?.force });
    filesWritten.push(destFile);
    fileDigests[destFile] = digest(contentToWrite);
  }

  const filesRemoved: string[] = [];
  for (const staleFile of plan.removals) {
    await assertNoSymlinkAncestors(staleFile);
    // Recheck ownership before deleting: the file may have changed since plan().
    if (!(await isManagedFile(staleFile, prior))) continue;
    await rm(staleFile, { force: true });
    filesRemoved.push(staleFile);
    delete fileDigests[staleFile];
    try {
      await rmdir(dirname(staleFile));
    } catch {
      // Parent may contain other files.
    }
  }

  // Keep references to user-edited stale files so future cleanup can still
  // distinguish them from untracked files after a partial reconciliation.
  const previousManifest = await readPreviousManifest(manifestPath, agentName);
  const retainedFiles = (previousManifest?.managedFiles ?? []).filter(
    (filePath) => isSafeManagedFilePath(agentRoot, filePath) &&
      filePath !== manifestPath &&
      !filesWritten.includes(filePath) &&
      !filesRemoved.includes(filePath),
  );

  const manifest: ManifestData = {
    managedBy: "skillgate",
    version: "1.0",
    agent: agentName,
    task: context.task,
    updatedAt: new Date().toISOString(),
    managedFiles: [...filesWritten, ...retainedFiles, manifestPath],
    fileDigests,
    skills: preparedSkills.map(({ skill, safeId }) => ({
      name: skill.metadata.name,
      identifier: safeId,
      description: skill.metadata.description,
      path: skill.path,
      score: skill.score,
      capabilities: skill.metadata.capabilities ?? [],
    })),
  };

  // Reapplying an unchanged selection must not churn the ownership manifest.
  // Compare semantic fields rather than timestamps, which are intentionally volatile.
  const existingManifest = prior;
  if (existingManifest && existingManifest.agent === manifest.agent &&
      existingManifest.task === manifest.task &&
      JSON.stringify(existingManifest.managedFiles) === JSON.stringify(manifest.managedFiles) &&
      JSON.stringify(existingManifest.skills) === JSON.stringify(manifest.skills) &&
      JSON.stringify(existingManifest.fileDigests ?? {}) === JSON.stringify(manifest.fileDigests ?? {})) {
    manifest.updatedAt = existingManifest.updatedAt;
  }
  await writeManagedFile(manifestPath, JSON.stringify(manifest, null, 2), { force: options?.force, manifest: true, agent: agentName });
  filesWritten.push(manifestPath);

  return {
    agent: agentName,
    filesWritten,
    filesRemoved,
    exposedSkills: plan.skills,
    summary: `Exposed ${plan.skills.length} skills to ${managedDirName}/skills/ (${filesWritten.length} written, ${filesRemoved.length} cleaned)`,
  };
}

export async function cleanupFilesystemAdapter(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<CleanupResult> {
  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  const manifestPath = resolveSafeSubpath(agentRoot, "skills.json");
  await assertNoSymlinkAncestors(manifestPath);
  const previousManifest = await readPreviousManifest(manifestPath, agentName);

  const filesRemoved: string[] = [];

  if (previousManifest) {
    // Delete the manifest last so an interrupted cleanup retains ownership
    // information for files that have not yet been removed.
    const orderedFiles = [
      ...previousManifest.managedFiles.filter((filePath) => filePath !== manifestPath),
      ...(previousManifest.managedFiles.includes(manifestPath) ? [manifestPath] : []),
    ];
    for (const filePath of orderedFiles) {
      if (!isSafeManagedFilePath(agentRoot, filePath)) continue;
      await assertNoSymlinkAncestors(filePath);
      // Preserve the manifest when any owned skill file remains (including
      // user-edited files), so a later cleanup can safely recover.
      if (filePath === manifestPath) {
        const remaining = await Promise.all(
          previousManifest.managedFiles
            .filter((candidate) => candidate !== manifestPath && isSafeManagedFilePath(agentRoot, candidate))
            .map(async (candidate) => {
              await assertNoSymlinkAncestors(candidate);
              return fileExists(candidate);
            }),
        );
        if (remaining.some(Boolean)) continue;
      }
      // The manifest is data, not authorization to remove a user-edited file.
      // A missing ownership marker must not be bypassed by a stale manifest entry.
      if (filePath !== manifestPath && !(await isManagedFile(filePath, previousManifest))) continue;
      if (await fileExists(filePath)) {
        const managed = filePath === manifestPath
          ? (await readPreviousManifest(filePath, agentName)) !== null
          : await isManagedFile(filePath, previousManifest);
        if (managed || options?.force) {
          await rm(filePath, { force: true });
          filesRemoved.push(filePath);
          try {
            await rmdir(dirname(filePath));
          } catch {
            // Directory not empty
          }
        }
      }
    }
  }

  return {
    agent: agentName,
    filesRemoved,
    summary: `Cleaned up ${filesRemoved.length} SkillGate-managed file(s) from ${managedDirName}/`,
  };
}
