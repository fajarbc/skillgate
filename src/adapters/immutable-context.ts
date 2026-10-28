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
  if (typeof context.task !== "string" || !wellFormedImmutableText(context.task)) {
    throw new Error("Invalid immutable adapter task");
  }
  const prepared = prepareSafeSkillPaths(context.skills, context.root);
  if (prepared.length > MAX_CONTEXT_SKILLS) {
    throw new Error("Immutable adapter context exceeds skill count limit");
  }
  const files: Record<string, Buffer> = Object.create(null);
  const metadata: Array<{
    name: string; identifier: string; description: string;
    path: string; sourcePath: string; score: number; capabilities: string[];
  }> = [];
  let total = 0;
  for (const { skill, safeId } of prepared) {
    // The reader rejects non-finite scores and malformed metadata. Enforce
    // those invariants before publishing any blob, not after publication.
    if (typeof skill.path !== "string" || !wellFormedImmutableText(skill.path) ||
        typeof skill.metadata.name !== "string" || !wellFormedImmutableText(skill.metadata.name) ||
        typeof skill.metadata.description !== "string" ||
        !wellFormedImmutableText(skill.metadata.description) ||
        typeof skill.score !== "number" || !Number.isFinite(skill.score) ||
        (skill.metadata.capabilities !== undefined &&
          (!Array.isArray(skill.metadata.capabilities) ||
           !skill.metadata.capabilities.every((capability) =>
             typeof capability === "string" && wellFormedImmutableText(capability))))) {
      throw new Error("Invalid immutable adapter skill metadata");
    }
    const logicalPath = `skills/${safeId}/SKILL.md`;
    const content = await readPreparedSkillSource(skill);
    const bytes = Buffer.from(OWNERSHIP_HEADER + content, "utf8");
    total += bytes.length;
    if (total > MAX_IMMUTABLE_BLOB_BYTES) {
      throw new Error("Immutable adapter context exceeds total byte limit");
    }
    files[logicalPath] = bytes;
    metadata.push({
      name: skill.metadata.name,
      identifier: safeId,
      description: skill.metadata.description,
      path: logicalPath,
      sourcePath: skill.path,
      score: skill.score,
      capabilities: skill.metadata.capabilities ?? [],
    });
  }
  metadata.sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: "1", agent, task: context.task, skills: metadata,
  }), "utf8");
  total += manifest.length;
  if (total > MAX_IMMUTABLE_BLOB_BYTES) {
    throw new Error("Immutable adapter context exceeds total byte limit");
  }
  files["skills.json"] = manifest;
  return files;
}
