import { access, lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
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

export async function readPreviousManifest(manifestPath: string): Promise<ManifestData | null> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.managedBy === "skillgate" && Array.isArray(parsed.managedFiles)) {
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

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isManagedFile(
  filePath: string,
  previousManifest: ManifestData | null,
): Promise<boolean> {
  if (previousManifest && previousManifest.managedFiles.includes(filePath)) {
    return true;
  }
  try {
    const content = await readFile(filePath, "utf8");
    return content.startsWith(OWNERSHIP_HEADER);
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
  const previousManifest = await readPreviousManifest(manifestPath);
  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);

  const plannedWrites: string[] = [];
  const conflicts: string[] = [];

  for (const { dirPath } of preparedSkills) {
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");
    plannedWrites.push(destFile);
    await assertNoSymlinkAncestors(destFile);

    if (await fileExists(destFile)) {
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
        if (await fileExists(prevFile) && await isManagedFile(prevFile, null)) {
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

  await assertNoSymlinkAncestors(skillsDir);
  await mkdir(skillsDir, { recursive: true });

  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);
  const filesWritten: string[] = [];

  for (const { skill, dirPath } of preparedSkills) {
    await assertNoSymlinkAncestors(dirPath);
    await mkdir(dirPath, { recursive: true });
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");

    let originalContent = "";
    try {
      originalContent = await readFile(skill.path, "utf8");
    } catch {
      originalContent = `---\nname: ${skill.metadata.name}\ndescription: ${skill.metadata.description}\n---\n`;
    }

    const contentToWrite = `${OWNERSHIP_HEADER}${originalContent}`;
    await writeFile(destFile, contentToWrite, "utf8");
    filesWritten.push(destFile);
  }

  const filesRemoved: string[] = [];
  for (const staleFile of plan.removals) {
    try {
      await assertNoSymlinkAncestors(staleFile);
      await rm(staleFile, { force: true });
      filesRemoved.push(staleFile);
      const parentDir = dirname(staleFile);
      try {
        await rmdir(parentDir);
      } catch {
        // Directory not empty
      }
    } catch {
      // Ignore
    }
  }

  const manifest: ManifestData = {
    managedBy: "skillgate",
    version: "1.0",
    agent: agentName,
    task: context.task,
    updatedAt: new Date().toISOString(),
    managedFiles: [...filesWritten, manifestPath],
    skills: preparedSkills.map(({ skill, safeId }) => ({
      name: skill.metadata.name,
      identifier: safeId,
      description: skill.metadata.description,
      path: skill.path,
      score: skill.score,
      capabilities: skill.metadata.capabilities ?? [],
    })),
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
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
  const previousManifest = await readPreviousManifest(manifestPath);

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
      // The manifest is data, not authorization to remove a user-edited file.
      // A missing ownership marker must not be bypassed by a stale manifest entry.
      if (filePath !== manifestPath && !(await isManagedFile(filePath, null))) continue;
      if (await fileExists(filePath)) {
        const managed = await isManagedFile(filePath, previousManifest);
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
