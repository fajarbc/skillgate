/** Filesystem-free recommendation preview. Both candidates and policy are
 * client-supplied; a hypothetical allow never authorizes reading a skill.
 * Compose the existing ranking and policy cores through their validated MCP
 * adapters instead of adding an alternate authorization implementation.
 */
import { RANK_PREVIEW_TOOL, rankPreviewResult } from "./rank-preview.js";
import { POLICY_PREVIEW_TOOL, policyPreviewResult } from "./policy-preview.js";

export const MCP_RECOMMEND_PREVIEW_SCHEMA_VERSION = "1" as const;

export const RECOMMEND_PREVIEW_TOOL = {
  name: "skillgate/recommend-metadata",
  description: "Rank caller-supplied metadata under a caller-supplied hypothetical policy. NEVER authorizes skill access or reads files.",
  inputSchema: {
    type: "object",
    properties: {
      task: RANK_PREVIEW_TOOL.inputSchema.properties.task,
      skills: {
        type: "array", maxItems: 64,
        items: {
          type: "object",
          properties: {
            ...RANK_PREVIEW_TOOL.inputSchema.properties.skills.items.properties,
            capabilities: POLICY_PREVIEW_TOOL.inputSchema.properties.capabilities,
          },
          required: ["id", "name", "description"],
          additionalProperties: false,
        },
      },
      policy: POLICY_PREVIEW_TOOL.inputSchema.properties.policy,
      limit: RANK_PREVIEW_TOOL.inputSchema.properties.limit,
    },
    required: ["task", "skills", "policy"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      schemaVersion: { const: MCP_RECOMMEND_PREVIEW_SCHEMA_VERSION },
      policySource: { const: "client-supplied" },
      authorizationGranted: { const: false },
      filesystemAccess: { const: "disabled" },
      ranked: RANK_PREVIEW_TOOL.outputSchema.properties.ranked,
    },
    required: ["schemaVersion", "policySource", "authorizationGranted", "filesystemAccess", "ranked"],
    additionalProperties: false,
  },
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recommendPreviewResult(value: unknown): Record<string, unknown> | null {
  if (!record(value) || Object.keys(value).some((key) =>
    !["task", "skills", "policy", "limit"].includes(key)) ||
    !Array.isArray(value.skills) || value.skills.length > 64 || !record(value.policy)) {
    return null;
  }

  // Validate policy even when no candidates are supplied. The sentinel name
  // is never ranked, returned, or used as an authorization decision.
  if (policyPreviewResult({ name: "SkillGate preview validation", policy: value.policy }) === null) {
    return null;
  }

  const all: Array<{ id: string; name: string; description: string }> = [];
  const allowed: typeof all = [];
  for (const candidate of value.skills) {
    if (!record(candidate) || Object.keys(candidate).some((key) =>
      !["id", "name", "description", "capabilities"].includes(key)) ||
      typeof candidate.id !== "string" || typeof candidate.name !== "string" ||
      typeof candidate.description !== "string") {
      return null;
    }
    const skill = { id: candidate.id, name: candidate.name, description: candidate.description };
    all.push(skill);
    const evaluation = policyPreviewResult({
      name: candidate.name, capabilities: candidate.capabilities, policy: value.policy,
    });
    if (evaluation === null) return null;
    if ((evaluation.structuredContent as { decision: string }).decision === "allow") {
      allowed.push(skill);
    }
  }

  // Validate all candidate metadata (including denied entries and duplicate
  // IDs) before filtering. Otherwise malformed denied skills could be hidden.
  if (rankPreviewResult({ task: value.task, skills: all, limit: value.limit }) === null) {
    return null;
  }
  const result = rankPreviewResult({ task: value.task, skills: allowed, limit: value.limit });
  if (result === null) return null;
  const payload = {
    schemaVersion: MCP_RECOMMEND_PREVIEW_SCHEMA_VERSION,
    policySource: "client-supplied",
    authorizationGranted: false,
    filesystemAccess: "disabled",
    ranked: (result.structuredContent as { ranked: unknown[] }).ranked,
  } as const;
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
