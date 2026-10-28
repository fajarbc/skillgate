/** Read-only preparation of adapter content for pinned immutable generations.
 * This never creates or changes an adapter-visible workspace pathname.
 */
import { OWNERSHIP_HEADER, readPreparedSkillSource } from "./filesystem-lifecycle.js";
import { prepareSafeSkillPaths } from "./safe-path.js";
import { MAX_IMMUTABLE_BLOB_BYTES } from "./immutable-store.js";
import type { AdapterContext } from "./types.js";

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
