import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateSkillPolicy, loadPolicy } from "./index.js";

describe("policy evaluation", () => {
  it("allows skills by default", () => {
    const result = evaluateSkillPolicy({
      path: "/skills/test/SKILL.md",
      metadata: { name: "safe-skill", description: "A safe skill" },
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("permitted by policy");
  });

  it("denies skills matching deniedSkills patterns", () => {
    const result = evaluateSkillPolicy(
      {
        path: "/skills/test/SKILL.md",
        metadata: { name: "unsafe-exec", description: "Unsafe runner" },
      },
      { deniedSkills: ["unsafe-*"] },
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("matches denied pattern");
  });

  it("denies skills declaring denied capabilities", () => {
    const result = evaluateSkillPolicy(
      {
        path: "/skills/test/SKILL.md",
        metadata: {
          name: "runner",
          description: "Runs commands",
          capabilities: ["exec", "filesystem"],
        },
      },
      { deniedCapabilities: ["exec"] },
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("denied capability 'exec'");
  });

  it("enforces allowedSkills restriction", () => {
    const allowed = evaluateSkillPolicy(
      {
        path: "/skills/a/SKILL.md",
        metadata: { name: "allowed-one", description: "Allowed" },
      },
      { allowedSkills: ["allowed-one"] },
    );
    expect(allowed.decision).toBe("allow");

    const denied = evaluateSkillPolicy(
      {
        path: "/skills/b/SKILL.md",
        metadata: { name: "other-skill", description: "Other" },
      },
      { allowedSkills: ["allowed-one"] },
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("not in allowed skills list");
  });

  it("enforces defaultAction: deny", () => {
    const result = evaluateSkillPolicy(
      {
        path: "/skills/test/SKILL.md",
        metadata: { name: "any-skill", description: "Desc" },
      },
      { defaultAction: "deny" },
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("default policy action is deny");
  });

  it("loads policy file from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({
        defaultAction: "allow",
        deniedCapabilities: ["network"],
      }),
    );

    const policy = await loadPolicy(root);
    expect(policy.defaultAction).toBe("allow");
    expect(policy.deniedCapabilities).toEqual(["network"]);

    await rm(root, { recursive: true, force: true });
  });
});
