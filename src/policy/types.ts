import type { SkillMetadata } from "../discovery/index.js";

export type PolicyAction = "allow" | "deny";

export interface PolicyConfig {
  defaultAction?: PolicyAction;
  allowedSkills?: string[];
  deniedSkills?: string[];
  allowedCapabilities?: string[];
  deniedCapabilities?: string[];
}

export interface PolicyDecisionRecord {
  decision: PolicyAction;
  reason: string;
}

export interface SkillPolicyEvaluation {
  skill: {
    path: string;
    metadata: SkillMetadata;
  };
  decision: PolicyAction;
  reason: string;
}
