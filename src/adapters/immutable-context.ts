/** Read-only preparation of adapter content for pinned immutable generations.
 * This never creates or changes an adapter-visible workspace pathname.
 */
import { OWNERSHIP_HEADER, readPreparedSkillSource } from "./filesystem-lifecycle.js";
import { prepareSafeSkillPaths } from "./safe-path.js";
import { MAX_IMMUTABLE_BLOB_BYTES } from "./immutable-store.js";
import type { AdapterContext } from "./types.js";

/** JSON can contain escaped unpaired UTF-16 surrogates even when the file
 * itself is valid UTF-8. Reject them before publishing portable metadata.
 */
export function wellFormedImmutableText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    }
  }
  return true;
}

/** One slot is reserved for skills.json in the 256-entry generation format. */
const MAX_CONTEXT_SKILLS = 255;

export async function prepareImmutableAdapterContext(
  agent: string,
  context: AdapterContext,
): Promise<Record<string, Buffer>> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) {
    throw new Error("Invalid immutable generation identity");
  }
  // Path preparation validates identifiers and collisions without statting,
  // creating, or trusting the legacy workspace destination.
  const task = context.task;
  if (typeof task !== "string" || !wellFormedImmutableText(task)) {
    throw new Error("Invalid immutable adapter task");
  }
  const prepared = prepareSafeSkillPaths(context.skills, context.root);
  if (prepared.length > MAX_CONTEXT_SKILLS) {
    throw new Error("Immutable adapter context exceeds skill count limit");
  }
  // Snapshot every skill before the first source I/O. Snapshotting one skill
  // per iteration leaves later entries mutable while earlier reads await.
  const snapshots = prepared.map(({ skill, safeId }) => {
    const sourcePath = skill.path;
    const { name, description, capabilities: rawCapabilities } = skill.metadata;
    const score = skill.score;
    // Array.from materializes sparse holes as undefined for validation.
    const capabilities = rawCapabilities === undefined ? [] :
      Array.isArray(rawCapabilities) ? Array.from(rawCapabilities) : null;
    if (typeof sourcePath !== "string" || !wellFormedImmutableText(sourcePath) ||
        typeof name !== "string" || !wellFormedImmutableText(name) ||
        typeof description !== "string" || !wellFormedImmutableText(description) ||
        typeof score !== "number" || !Number.isFinite(score) ||
        capabilities === null ||
        !capabilities.every((capability) =>
          typeof capability === "string" && wellFormedImmutableText(capability))) {
      throw new Error("Invalid immutable adapter skill metadata");
    }
    const logicalPath = `skills/${safeId}/SKILL.md`;
    const sourceSkill = {
      ...skill, path: sourcePath, score,
      metadata: { ...skill.metadata, name, description, capabilities },
    };
    return { name, safeId, description, sourcePath, score, capabilities, logicalPath, sourceSkill };
  });
  const files: Record<string, Buffer> = Object.create(null);
  const metadata: Array<{
    name: string; identifier: string; description: string;
    path: string; sourcePath: string; score: number; capabilities: string[];
  }> = [];
  let total = 0;
  for (const { name, safeId, description, sourcePath, score, capabilities, logicalPath, sourceSkill } of snapshots) {
    const content = await readPreparedSkillSource(sourceSkill);
    const bytes = Buffer.from(OWNERSHIP_HEADER + content, "utf8");
    total += bytes.length;
    if (total > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new Error("Immutable adapter context exceeds total byte limit");
    }
    files[logicalPath] = bytes;
    metadata.push({
      name,
      identifier: safeId,
      description,
      path: logicalPath,
      sourcePath,
      score,
      capabilities,
    });
  }
  metadata.sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: "1", agent, task, skills: metadata,
  }), "utf8");
  total += manifest.length;
  if (total > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new Error("Immutable adapter context exceeds total byte limit");
  }
  files["skills.json"] = manifest;
  return files;
}
