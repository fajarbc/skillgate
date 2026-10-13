import { access, lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";
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

function assertManifestPath(agentRoot: string, filePath: string): void {
  const file = resolve(filePath);
  const parts = relative(resolve(agentRoot, "skills"), file).split(sep);
  if (filePath !== file && filePath !== resolve(agentRoot, "skills.json")) {
    throw new Error("Invalid managed file path");
  }
  if (file !== resolve(agentRoot, "skills.json") &&
      !(parts.length === 2 && parts[0] !== ".." && parts[1] === "SKILL.md")) {
    throw new Error("Managed file is outside the adapter skill directory");
  }
}

async function assertNoSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing symlinked managed file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertSafeAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    await assertNoSymlink(current);
  }
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

  await assertSafeAncestors(manifestPath);
  const previousManifest = await readPreviousManifest(manifestPath);
  for (const path of previousManifest?.managedFiles ?? []) {
    assertManifestPath(agentRoot, path);
  }
  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);

  const plannedWrites: string[] = [];
  const conflicts: string[] = [];

  for (const { dirPath } of preparedSkills) {
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");
    await assertSafeAncestors(destFile);
    plannedWrites.push(destFile);

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
      if (prevFile !== manifestPath && !plannedWrites.includes(prevFile)) {
        await assertSafeAncestors(prevFile);
        if (await fileExists(prevFile)) {
          if (await isManagedFile(prevFile, previousManifest)) {
            plannedRemovals.push(prevFile);
          } else {
            conflicts.push(prevFile);
          }
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

  await assertSafeAncestors(skillsDir);
  await mkdir(skillsDir, { recursive: true });

  const preparedSkills = prepareSafeSkillPaths(context.skills, skillsDir);
  const filesWritten: string[] = [];

  for (const { skill, dirPath } of preparedSkills) {
    await assertSafeAncestors(dirPath);
    await mkdir(dirPath, { recursive: true });
    const destFile = resolveSafeSubpath(dirPath, "SKILL.md");

    let originalContent = "";
    try {
      originalContent = await readFile(skill.path, "utf8");
    } catch {
      originalContent = `---\nname: ${skill.metadata.name}\ndescription: ${skill.metadata.description}\n---\n`;
    }

    const contentToWrite = `${OWNERSHIP_HEADER}${originalContent}`;
    await assertSafeAncestors(destFile);
    await writeFile(destFile, contentToWrite, "utf8");
    filesWritten.push(destFile);
  }

  const filesRemoved: string[] = [];
  for (const staleFile of plan.removals) {
    try {
      await assertSafeAncestors(staleFile);
      if (!await isManagedFile(staleFile, null)) {
        throw new AdapterConflictError([staleFile]);
      }
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

  await assertSafeAncestors(manifestPath);
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
  await assertSafeAncestors(manifestPath);
  const previousManifest = await readPreviousManifest(manifestPath);
  for (const path of previousManifest?.managedFiles ?? []) {
    assertManifestPath(agentRoot, path);
  }

  const filesRemoved: string[] = [];

  if (previousManifest) {
    const managedSkillPaths = previousManifest.managedFiles.filter((path) => path !== manifestPath);
    // Preflight all targets before removing any file, so a conflict cannot
    // leave a partially cleaned installation.
    for (const filePath of managedSkillPaths) {
      await assertSafeAncestors(filePath);
      if (await fileExists(filePath) && !await isManagedFile(filePath, previousManifest)) {
        throw new AdapterConflictError([filePath]);
      }
    }
    for (const filePath of managedSkillPaths) {
      await assertSafeAncestors(filePath);
      if (await fileExists(filePath)) {
        if (!await isManagedFile(filePath, previousManifest)) {
          throw new AdapterConflictError([filePath]);
        }
        await rm(filePath, { force: true });
        filesRemoved.push(filePath);
        try {
          await rmdir(dirname(filePath));
        } catch {
          // Directory not empty
        }
      }
    }
    // The JSON manifest is validated separately and removed last.
    await assertSafeAncestors(manifestPath);
    if (await fileExists(manifestPath)) {
      await rm(manifestPath, { force: true });
      filesRemoved.push(manifestPath);
    }
  }

  return {
    agent: agentName,
    filesRemoved,
    summary: `Cleaned up ${filesRemoved.length} SkillGate-managed file(s) from ${managedDirName}/`,
  };
}
