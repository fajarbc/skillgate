import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillMetadata } from "../discovery/index.js";
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

export async function loadPolicy(root: string): Promise<PolicyConfig> {
  for (const relativePath of DEFAULT_POLICY_FILES) {
    const fullPath = join(root, relativePath);
    try {
      const content = await readFile(fullPath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        return {
          defaultAction: obj.defaultAction === "deny" ? "deny" : "allow",
          allowedSkills: Array.isArray(obj.allowedSkills)
            ? obj.allowedSkills.filter((s): s is string => typeof s === "string")
            : [],
          deniedSkills: Array.isArray(obj.deniedSkills)
            ? obj.deniedSkills.filter((s): s is string => typeof s === "string")
            : [],
          allowedCapabilities: Array.isArray(obj.allowedCapabilities)
            ? obj.allowedCapabilities.filter((s): s is string => typeof s === "string")
            : [],
          deniedCapabilities: Array.isArray(obj.deniedCapabilities)
            ? obj.deniedCapabilities.filter((s): s is string => typeof s === "string")
            : [],
        };
      }
    } catch {
      // Continue checking fallback file
    }
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
