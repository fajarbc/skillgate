/** Pure MCP policy evaluation preview. Both skill metadata and policy are supplied
 * by the caller: this is NEVER authorization to read a skill or workspace file.
 * Reuse the CLI's policy evaluator without loading configuration or policy files.
 */
import { evaluateSkillPolicy, validatePolicyConfig } from "../policy/index.js";

export const MCP_POLICY_PREVIEW_SCHEMA_VERSION = "1" as const;
const MAX_TEXT = 128;
const MAX_CAPABILITIES = 16;
const MAX_PATTERNS = 32;
const SAFE_TEXT_PATTERN = String.raw`^(?![\s\S]*[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069])[\s\S]*$`;
const SAFE_TEXT = new RegExp(SAFE_TEXT_PATTERN);
const POLICY_FIELDS = ["defaultAction", "allowedSkills", "deniedSkills", "allowedCapabilities", "deniedCapabilities"] as const;
const POLICY_ARRAY_FIELDS = ["allowedSkills", "deniedSkills", "allowedCapabilities", "deniedCapabilities"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON Schema length counts code points. Also reject lone escaped surrogates. */
function validText(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || !SAFE_TEXT.test(value)) return false;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i >= value.length) return false;
      const low = value.charCodeAt(i);
      if (low < 0xdc00 || low > 0xdfff) return false;
    }
    if (++count > MAX_TEXT) return false;
  }
  return true;
}

const safeTextSchema = {
  type: "string", minLength: 1, maxLength: MAX_TEXT, pattern: "\\S",
  allOf: [{ pattern: SAFE_TEXT_PATTERN }],
} as const;
/** Validate every candidate's capabilities before any recommendation policy decision.
 * Reuse the same bounded text rules as the policy-preview endpoint.
 */
export function validPreviewCapabilities(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) && value.length <= MAX_CAPABILITIES && value.every(validText));
}

const patternListSchema = {
  type: "array", maxItems: MAX_PATTERNS, items: safeTextSchema,
} as const;

export const POLICY_PREVIEW_TOOL = {
  name: "skillgate/evaluate-metadata-policy",
  description: "Preview a caller-supplied policy against caller-supplied skill metadata. NOT an authorization decision; never reads files.",
  inputSchema: {
    type: "object",
    properties: {
      name: safeTextSchema,
      capabilities: { type: "array", maxItems: MAX_CAPABILITIES, items: safeTextSchema },
      policy: {
        type: "object",
        properties: {
          defaultAction: { enum: ["allow", "deny"] },
          allowedSkills: patternListSchema,
          deniedSkills: patternListSchema,
          allowedCapabilities: patternListSchema,
          deniedCapabilities: patternListSchema,
        },
        additionalProperties: false,
      },
    },
    required: ["name", "policy"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      schemaVersion: { const: MCP_POLICY_PREVIEW_SCHEMA_VERSION },
      policySource: { const: "client-supplied" },
      authorizationGranted: { const: false },
      filesystemAccess: { const: "disabled" },
      decision: { enum: ["allow", "deny"] },
      reason: { type: "string" },
    },
    required: ["schemaVersion", "policySource", "authorizationGranted", "filesystemAccess", "decision", "reason"],
    additionalProperties: false,
  },
} as const;

/** Null means malformed arguments; no path or environment is ever consulted. */
export function policyPreviewResult(value: unknown): Record<string, unknown> | null {
  if (!record(value) || Object.keys(value).some((key) => !["name", "capabilities", "policy"].includes(key)) ||
      !validText(value.name) || !record(value.policy) ||
      Object.keys(value.policy).some((key) => !(POLICY_FIELDS as readonly string[]).includes(key)) ||
      (value.policy.defaultAction !== undefined &&
        value.policy.defaultAction !== "allow" && value.policy.defaultAction !== "deny") ||
      !validPreviewCapabilities(value.capabilities)) {
    return null;
  }
  for (const field of POLICY_ARRAY_FIELDS) {
    const patterns = value.policy[field];
    if (patterns !== undefined &&
        (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS || !patterns.every(validText))) {
      return null;
    }
  }

  // Validate using the same policy configuration parser as the CLI, without
  // reading any policy file. The sentinel path is never exposed to the client.
  const policy = validatePolicyConfig(value.policy, "<client-policy-preview>");
  const evaluation = evaluateSkillPolicy({
    path: "client-metadata",
    metadata: {
      name: value.name,
      description: "",
      capabilities: value.capabilities as string[] | undefined,
    },
  }, policy);
  const payload = {
    schemaVersion: MCP_POLICY_PREVIEW_SCHEMA_VERSION,
    policySource: "client-supplied",
    authorizationGranted: false,
    filesystemAccess: "disabled",
    decision: evaluation.decision,
    reason: evaluation.reason,
  } as const;
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
