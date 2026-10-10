import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguration } from "./index.js";
import { resolve } from "node:path";
import { ConfigurationError, parseConfiguration } from "./index.js";

describe("parseConfiguration", () => {
  const filename = resolve("fixtures/project/skillgate.yaml");

  it("resolves paths relative to the declaring file", () => {
    expect(parseConfiguration("version: 1\nskillRoots:\n  - ./skills\npolicyPath: ./policy.yaml", filename)).toMatchObject({
      version: 1,
      skillRoots: [resolve("fixtures/project/skills")],
      policyPath: resolve("fixtures/project/policy.yaml"),

    });
  });

  it("rejects unsupported versions and unknown keys", () => {
    expect(() => parseConfiguration("version: 2", filename)).toThrow(ConfigurationError);
    expect(() => parseConfiguration("version: 1\nsecret: true", filename)).toThrow('unknown key "secret"');
  });

  it("rejects malformed or invalid values", () => {
    expect(() => parseConfiguration("version: [", filename)).toThrow(ConfigurationError);
    expect(() => parseConfiguration("version: 1\ncandidateLimit: 0", filename)).toThrow("candidateLimit");
    expect(() => parseConfiguration('{"version":1,"skillRoots":[42]}', "config.json")).toThrow("skillRoots");
  });
});

describe("configuration precedence", () => {
  it("inherits omitted values and honors explicit overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-config-"));
    const userFile = join(root, "user.yaml");
    const explicitFile = join(root, "override.yaml");
    await writeFile(userFile, "version: 1\ncandidateLimit: 4\nadapters: [codex]\n");
    await writeFile(join(root, "skillgate.yaml"), "version: 1\nskillRoots: [./skills]\n");
    await writeFile(explicitFile, "version: 1\ncandidateLimit: 7\n");
    const effective = await resolveConfiguration({ root, userConfigFile: userFile, configFile: explicitFile });
    expect(effective.candidateLimit).toBe(7);
    expect(effective.adapters).toEqual(["codex"]);
    expect(effective.skillRoots).toEqual([join(root, "skills")]);
  });
});
