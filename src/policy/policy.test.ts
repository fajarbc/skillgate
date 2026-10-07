import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateSkillPolicy, loadPolicy, PolicyError } from "./index.js";

describe("policy evaluation", () => {
  it("allows skills by default when no policy file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    const policy = await loadPolicy(root);
    expect(policy.defaultAction).toBe("allow");

    const result = evaluateSkillPolicy(
      {
        path: "/skills/test/SKILL.md",
        metadata: { name: "safe-skill", description: "A safe skill" },
      },
      policy,
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("permitted by policy");

    await rm(root, { recursive: true, force: true });
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

  it("fails explicitly when policy JSON is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    await writeFile(join(root, "skillgate.policy.json"), "{ invalid json");

    await expect(loadPolicy(root)).rejects.toThrow(PolicyError);
    await expect(loadPolicy(root)).rejects.toThrow(/Failed to parse policy JSON/);

    await rm(root, { recursive: true, force: true });
  });

  it("fails explicitly when policy contains unsupported fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({ unsupportedField: true }),
    );

    await expect(loadPolicy(root)).rejects.toThrow(PolicyError);
    await expect(loadPolicy(root)).rejects.toThrow(/Unsupported policy field 'unsupportedField'/);

    await rm(root, { recursive: true, force: true });
  });

  it("fails explicitly on invalid defaultAction", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({ defaultAction: "maybe" }),
    );

    await expect(loadPolicy(root)).rejects.toThrow(PolicyError);
    await expect(loadPolicy(root)).rejects.toThrow(/Invalid defaultAction/);

    await rm(root, { recursive: true, force: true });
  });

  it("does not silently fall back when higher-precedence file is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-policy-"));
    await mkdir(join(root, ".skillgate"), { recursive: true });
    await writeFile(join(root, ".skillgate", "policy.json"), "{ broken");
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({ defaultAction: "allow" }),
    );

    await expect(loadPolicy(root)).rejects.toThrow(PolicyError);
    await expect(loadPolicy(root)).rejects.toThrow(/\.skillgate\/policy\.json/);

    await rm(root, { recursive: true, force: true });
  });

  it("loads valid policy file", async () => {
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
