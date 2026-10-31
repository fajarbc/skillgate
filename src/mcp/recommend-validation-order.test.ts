import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendPreviewResult } from "./recommend-preview.js";
import { policyPreviewResult } from "./policy-preview.js";

// Keep the real policy evaluator while recording when the recommendation
// preview invokes it. The first call validates the caller-supplied policy.
vi.mock("./policy-preview.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./policy-preview.js")>();
  return { ...original, policyPreviewResult: vi.fn(original.policyPreviewResult) };
});

const policyCalls = vi.mocked(policyPreviewResult);
const candidates = [
  { id: "safe", name: "React", description: "UI", capabilities: ["filesystem"] },
  { id: "other", name: "Python", description: "CLI", capabilities: ["network"] },
];
const valid = { task: "react", skills: candidates, policy: { defaultAction: "allow" } };

beforeEach(() => policyCalls.mockClear());

describe("MCP recommendation validation precedes candidate policy evaluation", () => {
  it.each([
    ["invalid task", { ...valid, task: " " }],
    ["oversized task", { ...valid, task: "x".repeat(4097) }],
    ["duplicate candidate ID", { ...valid, skills: [candidates[0], candidates[0]] }],
    ["invalid denied candidate ID", { ...valid,
      skills: [candidates[0], { ...candidates[1], id: "../escape" }],
      policy: { deniedSkills: ["Python"] } }],
    ["malformed description", { ...valid,
      skills: [candidates[0], { ...candidates[1], description: "x".repeat(513) }] }],
    ["invalid capability type in later candidate", { ...valid,
      skills: [candidates[0], { ...candidates[1], capabilities: [42] }] }],
    ["oversized capability list in later candidate", { ...valid,
      skills: [candidates[0], { ...candidates[1], capabilities: Array(17).fill("network") }] }],
    ["unsafe denied capability in later candidate", { ...valid,
      skills: [candidates[0], { ...candidates[1], capabilities: ["network\\u202e"] }],
      policy: { deniedSkills: ["Python"] } }],
    ["blank capability in later candidate", { ...valid,
      skills: [candidates[0], { ...candidates[1], capabilities: [" "] }] }],
  ])("rejects %s before candidate policy evaluation", (_label, input) => {
    expect(recommendPreviewResult(input)).toBeNull();
    // The initial policy-shape check is permitted, but no candidate should
    // reach policy evaluation when the complete ranking input is invalid.
    expect(policyCalls).toHaveBeenCalledTimes(1);
    expect(policyCalls).toHaveBeenCalledWith({
      name: "SkillGate preview validation", policy: input.policy,
    });
  });

  it("evaluates valid candidates and excludes denied ones", () => {
    const result = recommendPreviewResult({ ...valid,
      policy: { defaultAction: "allow", deniedCapabilities: ["network"] },
    });
    expect(result).toMatchObject({ structuredContent: {
      authorizationGranted: false, filesystemAccess: "disabled",
      ranked: [{ id: "safe" }],
    } });
    expect(policyCalls).toHaveBeenCalledTimes(3);
  });
});
