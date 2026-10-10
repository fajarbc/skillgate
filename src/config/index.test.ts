import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfiguration } from "./index.js";
import { resolve } from "node:path";
import { ConfigurationError, parseConfiguration, sanitizeConfiguration } from "./index.js";

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

  it("redacts sensitive adapter settings in public config output", () => {
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: { apiKey: "secret-value", accessToken: "hidden", mode: "safe" } },
    };
    expect(sanitizeConfiguration(config).adapterOptions.codex).toEqual({ apiKey: "[REDACTED]", accessToken: "[REDACTED]", mode: "safe" });
    expect(config.adapterOptions.codex.apiKey).toBe("secret-value");
  });

  it("validates adapter option values", () => {
    expect(parseConfiguration('{"version":1,"adapterOptions":{"codex":{"enabled":true,"limit":3,"mode":"safe"}}}', "config.json").adapterOptions).toEqual({ codex: { enabled: true, limit: 3, mode: "safe" } });
    expect(() => parseConfiguration('{"version":1,"adapterOptions":{"codex":{"unsafe":null}}}', "config.json")).toThrow("adapterOptions");
    expect(() => parseConfiguration('{"version":1,"adapterOptions":[]}', "config.json")).toThrow("adapterOptions");
  });

  it("rejects malformed or invalid values", () => {
    expect(() => parseConfiguration("version: [", filename)).toThrow(ConfigurationError);
    expect(() => parseConfiguration("version: 1\ncandidateLimit: 0", filename)).toThrow("candidateLimit");
    expect(() => parseConfiguration('{"version":1,"skillRoots":[42]}', "config.json")).toThrow("skillRoots");
  });
});

describe("configuration precedence", () => {
  it("merges per-adapter options without discarding lower-priority settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-adapter-options-"));
    const userFile = join(root, "user.yaml");
    const explicitFile = join(root, "override.yaml");
    await writeFile(userFile, "version: 1\nadapterOptions:\n  codex:\n    mode: safe\n    retries: 2\n");
    await writeFile(join(root, "skillgate.yaml"), "version: 1\nadapterOptions:\n  codex:\n    retries: 3\n  claude:\n    enabled: true\n");
    await writeFile(explicitFile, "version: 1\nadapterOptions:\n  codex:\n    mode: strict\n");
    const config = await resolveConfiguration({ root, userConfigFile: userFile, configFile: explicitFile });
    expect(config.adapterOptions).toEqual({ codex: { mode: "strict", retries: 3 }, claude: { enabled: true } });
  });

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
