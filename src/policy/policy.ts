import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillMetadata } from "../discovery/index.js";
import { PolicyError } from "./errors.js";
import type { PolicyConfig, SkillPolicyEvaluation } from "./types.js";

export const DEFAULT_POLICY_FILES = [
  join(".skillgate", "policy.json"),
  "skillgate.policy.json",
];

export const DEFAULT_POLICY: PolicyConfig = {
  defaultAction: "allow",
  allowedSkills: [],
  deniedSkills: [],
  allowedCapabilities: [],
  deniedCapabilities: [],
};

const ALLOWED_CONFIG_KEYS = new Set([
  "defaultAction",
  "allowedSkills",
  "deniedSkills",
  "allowedCapabilities",
  "deniedCapabilities",
]);

function validateStringArray(
  value: unknown,
  fieldName: string,
  filePath: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyError(`Field '${fieldName}' must be an array of strings`, filePath);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new PolicyError(`Field '${fieldName}' contains invalid non-string or empty item`, filePath);
    }
  }
  return value.map((s) => s.trim());
}

export function validatePolicyConfig(parsed: unknown, filePath: string): PolicyConfig {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PolicyError("Policy file must contain a JSON object", filePath);
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new PolicyError(`Unsupported policy field '${key}'`, filePath);
    }
  }

  let defaultAction: "allow" | "deny" = "allow";
  if (obj.defaultAction !== undefined) {
    if (obj.defaultAction !== "allow" && obj.defaultAction !== "deny") {
      throw new PolicyError(
        `Invalid defaultAction '${String(obj.defaultAction)}': must be 'allow' or 'deny'`,
        filePath,
      );
    }
    defaultAction = obj.defaultAction;
  }

  const allowedSkills =
    obj.allowedSkills !== undefined
      ? validateStringArray(obj.allowedSkills, "allowedSkills", filePath)
      : [];

  const deniedSkills =
    obj.deniedSkills !== undefined
      ? validateStringArray(obj.deniedSkills, "deniedSkills", filePath)
      : [];

  const allowedCapabilities =
    obj.allowedCapabilities !== undefined
      ? validateStringArray(obj.allowedCapabilities, "allowedCapabilities", filePath)
      : [];

  const deniedCapabilities =
    obj.deniedCapabilities !== undefined
      ? validateStringArray(obj.deniedCapabilities, "deniedCapabilities", filePath)
      : [];

  return {
    defaultAction,
    allowedSkills,
    deniedSkills,
    allowedCapabilities,
    deniedCapabilities,
  };
}

export async function loadPolicy(root: string, explicitPath?: string): Promise<PolicyConfig> {
  for (const relativePath of explicitPath ? [explicitPath] : DEFAULT_POLICY_FILES) {
    const fullPath = explicitPath ? explicitPath : join(root, relativePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch (err: unknown) {
      const isNotFound = (err as { code?: string })?.code === "ENOENT";
      if (isNotFound && !explicitPath) {
        continue;
      }
      throw new PolicyError(`Failed to read policy file: ${(err as Error).message}`, relativePath);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      throw new PolicyError(`Failed to parse policy JSON: ${(err as Error).message}`, relativePath);
    }

    return validatePolicyConfig(parsed, relativePath);
  }

  return DEFAULT_POLICY;
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*" || pattern === name) return true;
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export function evaluateSkillPolicy(
  skill: { path: string; metadata: SkillMetadata },
  policy: PolicyConfig = DEFAULT_POLICY,
): SkillPolicyEvaluation {
  const name = skill.metadata.name;
  const capabilities = skill.metadata.capabilities ?? [];

  if (policy.deniedSkills && policy.deniedSkills.length > 0) {
    const matchedDeny = policy.deniedSkills.find((p) => matchesPattern(name, p));
    if (matchedDeny) {
      return {
        skill,
        decision: "deny",
        reason: `skill matches denied pattern '${matchedDeny}'`,
      };
    }
  }

  if (policy.deniedCapabilities && policy.deniedCapabilities.length > 0) {
    for (const cap of capabilities) {
      const matchedCap = policy.deniedCapabilities.find((p) => matchesPattern(cap, p));
      if (matchedCap) {
        return {
          skill,
          decision: "deny",
          reason: `skill declares denied capability '${cap}'`,
        };
      }
    }
  }

  if (policy.allowedCapabilities && policy.allowedCapabilities.length > 0) {
    for (const cap of capabilities) {
      const isAllowed = policy.allowedCapabilities.some((p) => matchesPattern(cap, p));
      if (!isAllowed) {
        return {
          skill,
          decision: "deny",
          reason: `capability '${cap}' is not in allowed capabilities list`,
        };
      }
    }
  }

  if (policy.allowedSkills && policy.allowedSkills.length > 0) {
    const matchedAllow = policy.allowedSkills.find((p) => matchesPattern(name, p));
    if (!matchedAllow) {
      return {
        skill,
        decision: "deny",
        reason: `skill '${name}' is not in allowed skills list`,
      };
    }
  }

  if (policy.defaultAction === "deny") {
    return {
      skill,
      decision: "deny",
      reason: "default policy action is deny",
    };
  }

  return {
    skill,
    decision: "allow",
    reason: "permitted by policy",
  };
}

export function evaluatePolicies(
  skills: Array<{ path: string; metadata: SkillMetadata }>,
  policy: PolicyConfig = DEFAULT_POLICY,
): SkillPolicyEvaluation[] {
  return skills.map((skill) => evaluateSkillPolicy(skill, policy));
}
