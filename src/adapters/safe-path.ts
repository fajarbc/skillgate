import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RankedSkill } from "../ranking/index.js";

const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function toSafeSkillIdentifier(rawName: string): string {
  if (!rawName || typeof rawName !== "string") {
    throw new Error("Invalid skill name: name must be a non-empty string");
  }

  let decoded = rawName;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    // Keep raw if URI decode fails
  }

  let cleaned = decoded.replace(/[\x00-\x1f\x7f]/g, "");
  cleaned = cleaned.replace(/[<>:"/\\|?*]/g, "-").trim();

  let normalized = cleaned
    .replace(/^[.\s-]+/, "")
    .replace(/[.\s-]+$/, "")
    .toLowerCase();

  normalized = normalized.replace(/[\s_]+/g, "-");
  normalized = normalized.replace(/-+/g, "-");

  while (normalized.includes("..")) {
    normalized = normalized.replace(/\.\./g, "");
  }
  normalized = normalized.replace(/^[.\s-]+/, "").replace(/[.\s-]+$/, "");

  if (!normalized) {
    throw new Error(`Unsafe skill name '${rawName}': cannot be resolved to a valid identifier`);
  }

  const baseName = normalized.split(".")[0] ?? normalized;
  if (WINDOWS_RESERVED.has(baseName.toLowerCase())) {
    throw new Error(`Unsafe skill name '${rawName}': '${baseName}' is a reserved device name`);
  }

  return normalized;
}

export function resolveSafeSubpath(rootDir: string, subpath: string): string {
  if (!subpath || typeof subpath !== "string") {
    throw new Error("Invalid subpath: must be a non-empty string");
  }

  if (
    isAbsolute(subpath) ||
    subpath.startsWith("/") ||
    subpath.startsWith("\\") ||
    /^[a-zA-Z]:[/\\]/.test(subpath)
  ) {
    throw new Error(`Unsafe path '${subpath}': absolute paths are not permitted`);
  }

  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(resolvedRoot, subpath);

  const rel = relative(resolvedRoot, resolvedTarget);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel)
  ) {
    throw new Error(`Path traversal attempt detected: '${subpath}' resolves outside root '${rootDir}'`);
  }

  return resolvedTarget;
}

export interface PreparedSafeSkill {
  skill: RankedSkill;
  safeId: string;
  dirPath: string;
}

export function prepareSafeSkillPaths(
  skills: RankedSkill[],
  skillsRootDir: string,
): PreparedSafeSkill[] {
  const seen = new Map<string, string>();
  const prepared: PreparedSafeSkill[] = [];

  for (const skill of skills) {
    const originalName = skill.metadata.name;
    const safeId = toSafeSkillIdentifier(originalName);

    const existing = seen.get(safeId);
    if (existing && existing !== originalName) {
      throw new Error(
        `Skill name collision: '${originalName}' and '${existing}' normalize to the same identifier '${safeId}'`,
      );
    }
    seen.set(safeId, originalName);

    const dirPath = resolveSafeSubpath(skillsRootDir, safeId);
    prepared.push({ skill, safeId, dirPath });
  }

  return prepared;
}
