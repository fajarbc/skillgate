/** Pure ranking preview for caller-supplied metadata. No filesystem, discovery,
 * policy, configuration, environment, or skill-instruction access is possible.
 * A score is NOT a policy authorization decision.
 */
import { rankSkills } from "../ranking/index.js";

export const MCP_RANK_PREVIEW_SCHEMA_VERSION = "1" as const;
const MAX_TASK_LENGTH = 4096;
const MAX_SKILLS = 64;
const MAX_RESULTS = 8;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Names are reflected in MCP tool results. Forbid terminal controls and
 * bidirectional overrides without restricting ordinary international text.
 * The same JSON Schema pattern is enforced at runtime.
 */
const SAFE_DISPLAY_NAME_PATTERN = String.raw`^(?![\s\S]*[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069])[\s\S]*$`;
const SAFE_DISPLAY_NAME = new RegExp(SAFE_DISPLAY_NAME_PATTERN);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON Schema maxLength counts Unicode code points, not UTF-16 units.
 * Reject lone surrogates, which JSON.parse can admit through \\u escapes.
 */
function validTextLength(value: string, maximum: number): boolean {
  let points = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= value.length) return false;
      const low = value.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return false;
    }
    if (++points > maximum) return false;
  }
  return true;
}

export const RANK_PREVIEW_TOOL = {
  name: "skillgate/rank-metadata",
  description: "Score client-provided skill metadata using SkillGate ranking. Not discovery or policy approval; never reads files.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, maxLength: MAX_TASK_LENGTH, pattern: "\\S" },
      skills: {
        type: "array", maxItems: MAX_SKILLS,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
            name: { type: "string", minLength: 1, maxLength: 128, pattern: "\\S",
              allOf: [{ pattern: SAFE_DISPLAY_NAME_PATTERN }] },
            description: { type: "string", maxLength: 512 },
          },
          required: ["id", "name", "description"],
          additionalProperties: false,
        },
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
    },
    required: ["task", "skills"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      schemaVersion: { const: MCP_RANK_PREVIEW_SCHEMA_VERSION },
      policyEvaluated: { const: false },
      filesystemAccess: { const: "disabled" },
      ranked: {
        type: "array", maxItems: MAX_RESULTS,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            score: { type: "number" },
            reasons: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  source: { enum: ["name", "description", "project"] },
                  term: { type: "string" },
                  points: { type: "number" },
                },
                required: ["source", "term", "points"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "name", "score", "reasons"],
          additionalProperties: false,
        },
      },
    },
    required: ["schemaVersion", "policyEvaluated", "filesystemAccess", "ranked"],
    additionalProperties: false,
  },
} as const;

/** Invalid arguments fail closed; never pass unvalidated objects into core. */
export function rankPreviewResult(value: unknown): Record<string, unknown> | null {
  if (!record(value) || Object.keys(value).some((key) => !["task", "skills", "limit"].includes(key)) ||
      typeof value.task !== "string" || !value.task.trim() || !validTextLength(value.task, MAX_TASK_LENGTH) ||
      !Array.isArray(value.skills) || value.skills.length > MAX_SKILLS ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 1 || (value.limit as number) > MAX_RESULTS))) {
    return null;
  }

  const skills: Array<{ path: string; metadata: { name: string; description: string } }> = [];
  const ids = new Set<string>();
  for (const item of value.skills) {
    if (!record(item) || Object.keys(item).some((key) => !["id", "name", "description"].includes(key)) ||
        typeof item.id !== "string" || !SKILL_ID.test(item.id) || ids.has(item.id) ||
        typeof item.name !== "string" || !item.name.trim() || !validTextLength(item.name, 128) ||
        !SAFE_DISPLAY_NAME.test(item.name) ||
        typeof item.description !== "string" || !validTextLength(item.description, 512)) {
      return null;
    }
    ids.add(item.id);
    // The path field is only a ranking tie-break key. It is never opened or
    // returned as a filesystem path; ids are restricted to opaque tokens.
    skills.push({ path: item.id, metadata: { name: item.name, description: item.description } });
  }

  const ranked = rankSkills({
    task: value.task,
    skills,
    signals: [],
    limit: value.limit === undefined ? MAX_RESULTS : value.limit as number,
  }).map((skill) => ({
    id: skill.path,
    name: skill.metadata.name,
    score: skill.score,
    reasons: skill.reasons.map((reason) => ({
      source: reason.source, term: reason.term, points: reason.points,
    })),
  }));
  const payload = {
    schemaVersion: MCP_RANK_PREVIEW_SCHEMA_VERSION,
    policyEvaluated: false,
    filesystemAccess: "disabled",
    ranked,
  };
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
