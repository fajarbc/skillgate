import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ConfigurationError, parseConfiguration } from "./index.js";

describe("parseConfiguration", () => {
  const filename = resolve("fixtures/project/skillgate.yaml");

  it("resolves paths relative to the declaring file", () => {
    expect(parseConfiguration("version: 1\nskillRoots:\n  - ./skills\npolicyPath: ./policy.yaml", filename)).toMatchObject({
      version: 1,
      skillRoots: [resolve("fixtures/project/skills")],
      policyPath: resolve("fixtures/project/policy.yaml"),
      candidateLimit: 10,
      adapters: [],
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
