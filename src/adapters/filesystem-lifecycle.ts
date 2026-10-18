import { link, lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { prepareSafeSkillPaths, resolveSafeSubpath, toSafeSkillIdentifier } from "./safe-path.js";
import type {
  AdapterContext,
  AdapterPlan,
  AdapterResult,
  CleanupResult,
  LifecycleOptions,
} from "./types.js";

export const OWNERSHIP_HEADER = "<!-- Managed by SkillGate. Do not edit directly. -->\n";
/**
 * Serialize mutations by cooperating SkillGate processes targeting one adapter root.
 * The lock lives outside the workspace so cleanup never creates a missing root.
 * Crashed-process locks require manual inspection; external writers are not protected.
 */
async function withAdapterMutationLock<T>(agentRoot: string, work: () => Promise<T>): Promise<T> {
  const lockPath = join(tmpdir(), `skillgate-adapter-${digest(agentRoot)}.lock`);
  const startedAt = Date.now();
  await assertNoSymlinkAncestors(lockPath);
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertNoSymlinkAncestors(lockPath);
      if (Date.now() - startedAt >= 30_000) {
        throw new Error(`Timed out waiting for SkillGate adapter lock: ${lockPath}`);
      }
      await delay(50);
    }
  }
  try {
    return await work();
  } finally {
    // Never recursively remove a lock directory whose contents we do not own.
    await rmdir(lockPath);
  }
}


export interface ManifestData {
  managedBy: "skillgate";
  version: "1.0";
  agent: string;
  task: string;
  updatedAt: string;
  managedFiles: string[];
  /** SHA-256 of managed skill file bytes; missing entries support older manifests. */
  fileDigests?: Record<string, string>;
  /** Previously verified digests while an apply is pending. */
  previousFileDigests?: Record<string, string>;
  phase?: "pending";
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
      parsed.managedFiles.every((file: unknown) => typeof file === "string") &&
      (parsed.fileDigests === undefined ||
        (parsed.fileDigests !== null && typeof parsed.fileDigests === "object" &&
          !Array.isArray(parsed.fileDigests) &&
          Object.values(parsed.fileDigests).every((value) =>
            typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))) &&
      (parsed.phase === undefined || parsed.phase === "pending") &&
      (parsed.previousFileDigests === undefined ||
        (parsed.phase === "pending" && parsed.previousFileDigests !== null &&
          typeof parsed.previousFileDigests === "object" &&
          !Array.isArray(parsed.previousFileDigests) &&
          Object.values(parsed.previousFileDigests).every((value) =>
            typeof value === "string" && /^[a-f0-9]{64}$/.test(value)))) {
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
  if (segments.length !== 3 || segments[0] !== "skills" || segments[2] !== "SKILL.md") return false;
  // Accept exactly the identifiers that the writer can generate, including Unicode.
  // Never authorize arbitrary paths or identifiers that normalize differently.
  try {
    return toSafeSkillIdentifier(segments[1] ?? "") === segments[1];
  } catch {
    return false;
  }
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
async function writeManagedFile(path: string, content: string, options?: { force?: boolean; manifest?: boolean; agent?: string; expectedManifest?: ManifestData | null; expectedManifestDigest?: string; ownershipManifestPath?: string; ownershipManifestDigest?: string }): Promise<void> {
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
    // access() follows symlinks and treats dangling symlinks as missing.
    // lstat() detects the directory entry itself, preventing unsafe writes.
    let exists = false;
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new AdapterConflictError([path]);
      }
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      // Force permits an intentional overwrite, not replacement of a manifest
      // changed after this apply read its previous ownership state.
      if (options?.manifest) {
        // A manifest created after planning is not automatically ours.
        // Without a recorded digest, only an explicit force may replace it.
        if (!options.expectedManifestDigest && !options.force) {
          throw new AdapterConflictError([path]);
        }
        if (options.expectedManifestDigest) {
          const current = await readFile(path, "utf8");
          if (digest(current) !== options.expectedManifestDigest) {
            throw new AdapterConflictError([path]);
          }
        }
      }
      if (!options?.force) {
        const owned = options?.manifest
          ? (await readPreviousManifest(path, options.agent)) !== null
          : (options?.expectedManifest ? await isManagedFile(path, options.expectedManifest) : false);
        if (!owned) throw new AdapterConflictError([path]);
      }
    }
    // Recheck after staging and ownership inspection, immediately before installation.
    if (exists && options?.manifest && options.expectedManifestDigest) {
      await assertManifestDigest(path, options.expectedManifestDigest);
    }
    if (options?.ownershipManifestPath && options.ownershipManifestDigest) {
      await assertManifestDigest(options.ownershipManifestPath, options.ownershipManifestDigest);
    }
    if (exists && !options?.manifest && !options?.force &&
        !(await isManagedFile(path, options?.expectedManifest ?? null))) {
      throw new AdapterConflictError([path]);
    }
    if (exists) {
      // Replacing an existing owned file still requires stronger concurrency coordination.
      await rename(temporaryPath, path);
    } else {
      // A hard link creates the destination atomically without replacing a file
      // another process might have created after the existence check.
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AdapterConflictError([path]);
        }
        throw error;
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    // Inspect the directory entry itself: a dangling symlink is not absent.
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Permission and I/O errors must never be interpreted as an empty path.
    throw error;
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Fail closed if ownership metadata changes while a mutation is in progress. */
async function assertManifestDigest(manifestPath: string, expectedDigest: string): Promise<void> {
  await assertNoSymlinkAncestors(manifestPath);
  try {
    if (digest(await readFile(manifestPath, "utf8")) === expectedDigest) return;
  } catch {
    // Missing or unreadable ownership metadata cannot authorize mutations.
  }
  throw new AdapterConflictError([manifestPath]);
}

export async function isManagedFile(
  filePath: string,
  previousManifest: ManifestData | null,
): Promise<boolean> {
  if (!previousManifest || !previousManifest.managedFiles.includes(filePath)) return false;
  try {
    const content = await readFile(filePath, "utf8");
    if (!content.startsWith(OWNERSHIP_HEADER)) return false;
    // A digest-aware manifest must prove ownership for this exact file.
    // Older manifests without fileDigests retain legacy marker compatibility.
    if (previousManifest.fileDigests === undefined) return true;
    const expected = previousManifest.fileDigests[filePath];
    const actual = digest(content);
    if (typeof expected === "string" && expected === actual) return true;
    return previousManifest.phase === "pending" &&
      previousManifest.previousFileDigests?.[filePath] === actual;
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

async function applyFilesystemAdapterUnlocked(
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
  // Do not proceed if an unrecognized or foreign manifest appeared after plan().
  // A missing manifest is the only safe no-digest starting state.
  if (!prior && await fileExists(manifestPath) && !options?.force) {
    throw new AdapterConflictError([manifestPath]);
  }
  const priorManifestRaw = prior ? await readFile(manifestPath, "utf8") : undefined;
  // The parsed manifest and digest must describe the same snapshot. Otherwise
  // an external writer could change ownership between our two reads.
  if (priorManifestRaw) {
    try {
      if (JSON.stringify(JSON.parse(priorManifestRaw)) !== JSON.stringify(prior)) {
        throw new AdapterConflictError([manifestPath]);
      }
    } catch {
      throw new AdapterConflictError([manifestPath]);
    }
  }
  const priorManifestDigest = priorManifestRaw === undefined ? undefined : digest(priorManifestRaw);
  // Record only current, verified owned bytes before advertising replacements.
  const previousVerifiedDigests: Record<string, string> = {};
  if (prior) {
    for (const filePath of prior.managedFiles) {
      if (!isSafeManagedFilePath(agentRoot, filePath) || filePath === manifestPath) continue;
      await assertNoSymlinkAncestors(filePath);
      try {
        const current = await readFile(filePath, "utf8");
        if (!current.startsWith(OWNERSHIP_HEADER)) continue;
        const currentDigest = digest(current);
        const verified = prior.fileDigests === undefined ||
          prior.fileDigests[filePath] === currentDigest ||
          (prior.phase === "pending" && prior.previousFileDigests?.[filePath] === currentDigest);
        if (verified) previousVerifiedDigests[filePath] = currentDigest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const plannedDigests = Object.fromEntries(preparedSkills.map(({ dirPath }, index) => [
    resolveSafeSubpath(dirPath, "SKILL.md"),
    digest(`${OWNERSHIP_HEADER}${preparedContents[index]}`),
  ]));
  const pending: ManifestData = {
    managedBy: "skillgate", version: "1.0", agent: agentName,
    task: context.task, updatedAt: new Date().toISOString(),
    managedFiles: [...new Set([
      ...(prior?.managedFiles ?? []).filter((p) => isSafeManagedFilePath(agentRoot, p)),
      ...preparedSkills.map(({ dirPath }) => resolveSafeSubpath(dirPath, "SKILL.md")),
      manifestPath,
    ])],
    fileDigests: { ...(prior?.fileDigests ?? {}), ...plannedDigests },
    phase: "pending",
    previousFileDigests: previousVerifiedDigests,
    skills: preparedSkills.map(({ skill, safeId }) => ({
      name: skill.metadata.name, identifier: safeId,
      description: skill.metadata.description, path: skill.path,
      score: skill.score, capabilities: skill.metadata.capabilities ?? [],
    })),
  };
  const pendingDigest = digest(JSON.stringify(pending, null, 2));
  await writeManagedFile(manifestPath, JSON.stringify(pending, null, 2), {
    force: options?.force, manifest: true, agent: agentName,
    expectedManifestDigest: priorManifestDigest,
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
    await assertManifestDigest(manifestPath, pendingDigest);
    await writeManagedFile(destFile, contentToWrite, {
      force: options?.force, expectedManifest: prior,
      ownershipManifestPath: manifestPath, ownershipManifestDigest: pendingDigest,
    });
    filesWritten.push(destFile);
    fileDigests[destFile] = digest(contentToWrite);
  }

  const filesRemoved: string[] = [];
  for (const staleFile of plan.removals) {
    await assertNoSymlinkAncestors(staleFile);
    // Recheck ownership before deleting: the file may have changed since plan().
    if (!(await isManagedFile(staleFile, prior))) continue;
    await assertManifestDigest(manifestPath, pendingDigest);
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
  await writeManagedFile(manifestPath, JSON.stringify(manifest, null, 2), {
    force: options?.force, manifest: true, agent: agentName,
    expectedManifestDigest: digest(JSON.stringify(pending, null, 2)),
  });
  filesWritten.push(manifestPath);

  return {
    agent: agentName,
    filesWritten,
    filesRemoved,
    exposedSkills: plan.skills,
    summary: `Exposed ${plan.skills.length} skills to ${managedDirName}/skills/ (${filesWritten.length} written, ${filesRemoved.length} cleaned)`,
  };
}

async function cleanupFilesystemAdapterUnlocked(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<CleanupResult> {
  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  const manifestPath = resolveSafeSubpath(agentRoot, "skills.json");
  await assertNoSymlinkAncestors(manifestPath);
  const previousManifest = await readPreviousManifest(manifestPath, agentName);
  // Capture the exact manifest bytes used to authorize cleanup. A different
  // valid manifest must not be removed just because its agent name matches.
  const manifestRaw = previousManifest ? await readFile(manifestPath, "utf8") : undefined;
  if (manifestRaw) {
    try {
      if (JSON.stringify(JSON.parse(manifestRaw)) !== JSON.stringify(previousManifest)) {
        throw new AdapterConflictError([manifestPath]);
      }
    } catch {
      throw new AdapterConflictError([manifestPath]);
    }
  }
  const expectedManifestDigest = manifestRaw === undefined ? undefined : digest(manifestRaw);

  const filesRemoved: string[] = [];

  // Manifest ownership is revalidated before each cleanup deletion.
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
          ? (await readPreviousManifest(filePath, agentName)) !== null &&
            digest(await readFile(filePath, "utf8")) === expectedManifestDigest
          : await isManagedFile(filePath, previousManifest);
        // Cleanup only removes bytes verified against the previous manifest.
        // Force does not authorize deletion of independently edited files.
        if (managed) {
          if (expectedManifestDigest) await assertManifestDigest(manifestPath, expectedManifestDigest);
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

/** Mutating lifecycle operations for the same adapter root are serialized. */
export async function applyFilesystemAdapter(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<AdapterResult> {
  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  return withAdapterMutationLock(agentRoot, () =>
    applyFilesystemAdapterUnlocked(agentName, managedDirName, context, options));
}

export async function cleanupFilesystemAdapter(
  agentName: string,
  managedDirName: string,
  context: AdapterContext,
  options?: LifecycleOptions,
): Promise<CleanupResult> {
  const agentRoot = resolveSafeSubpath(context.root, managedDirName);
  return withAdapterMutationLock(agentRoot, () =>
    cleanupFilesystemAdapterUnlocked(agentName, managedDirName, context, options));
}
