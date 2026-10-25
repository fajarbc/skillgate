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

  it("redacts signed URL credentials without changing safe options or source configuration", () => {
    const options = {
      aws: "https://s3.example.org/object?X-Amz-Signature=signed-secret",
      google: "https://storage.example.org/object?X-Goog-Signature=signed-secret",
      azure: "https://blob.example.org/object?sv=2024-01-01&sig=signed-secret",
      maps: "https://maps.example.org/lookup?key=signed-secret",
      fragment: "https://example.org/callback#sig=signed-secret",
      safeUrl: "https://example.org/search?design=default&mode=safe",
      mode: "safe",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      aws: "[REDACTED]",
      google: "[REDACTED]",
      azure: "[REDACTED]",
      maps: "[REDACTED]",
      fragment: "[REDACTED]",
      safeUrl: options.safeUrl,
      mode: "safe",
    });
    expect(config.adapterOptions.codex).toEqual(options);
    expect(JSON.stringify(sanitized)).not.toContain("signed-secret");
  });

  it("redacts double-encoded signed URL credential parameter names", () => {
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: {
        codex: {
          query: "https://example.org/data?access%255Ftoken=secret-canary",
          fragment: "https://example.org/data#api%255Fkey=secret-canary",
          safe: "https://example.org/data?design%2520mode=preview",
        },
      },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      query: "[REDACTED]",
      fragment: "[REDACTED]",
      safe: config.adapterOptions.codex.safe,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex.query).toContain("secret-canary");
  });

  it("redacts deeply encoded URL credentials and malformed escape keys", () => {
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: {
        codex: {
          nestedQuery: "https://example.org/data?api%25255Fkey=secret-canary",
          nestedFragment: "https://example.org/data#api%25255Fkey=secret-canary",
          malformed: "https://example.org/data?%25ZZ=secret-canary",
          safe: "https://example.org/data?design%252520mode=preview",
        },
      },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      nestedQuery: "[REDACTED]",
      nestedFragment: "[REDACTED]",
      malformed: "[REDACTED]",
      safe: config.adapterOptions.codex.safe,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex.nestedQuery).toContain("secret-canary");
  });

  it("redacts percent-encoded adapter option names without mutating source settings", () => {
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: {
        codex: {
          "api%5Fkey": "secret-canary",
          "api%25255Fkey": "nested-secret-canary",
          "api%ZZ": "malformed-secret-canary",
          "design%2520mode": "preview",
          mode: "safe",
        },
      },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      "api%5Fkey": "[REDACTED]",
      "api%25255Fkey": "[REDACTED]",
      "api%ZZ": "[REDACTED]",
      "design%2520mode": "preview",
      mode: "safe",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex["api%5Fkey"]).toBe("secret-canary");
  });

  it("redacts password aliases in adapter keys and credential-bearing URLs", () => {
    const options = {
      pwd: "secret-canary",
      passwd: "secret-canary",
      passphrase: "secret-canary",
      db: "postgresql://example.test/db?pwd=secret-canary",
      callback: "https://example.test/callback#passphrase=secret-canary",
      endpoint: "https://example.test/connect?passwd=secret-canary",
      safeUrl: "https://example.test/docs?mode=read",
      mode: "safe",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      pwd: "[REDACTED]",
      passwd: "[REDACTED]",
      passphrase: "[REDACTED]",
      db: "[REDACTED]",
      callback: "[REDACTED]",
      endpoint: "[REDACTED]",
      safeUrl: options.safeUrl,
      mode: "safe",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts dotted and space-delimited credential keys in options and URLs", () => {
    const options = {
      "api.key": "credential-canary",
      "access key": "credential-canary",
      "private.key": "credential-canary",
      endpoint: "https://example.org/path?api.key=credential-canary",
      encoded: "https://example.org/path?api%2Ekey=credential-canary",
      fragment: "https://example.org/path#access+key=credential-canary",
      safeUrl: "https://example.org/path?design.mode=preview",
      keyboard: "enabled",
      mode: "safe",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      "api.key": "[REDACTED]",
      "access key": "[REDACTED]",
      "private.key": "[REDACTED]",
      endpoint: "[REDACTED]",
      encoded: "[REDACTED]",
      fragment: "[REDACTED]",
      safeUrl: options.safeUrl,
      keyboard: "enabled",
      mode: "safe",
    });
    expect(JSON.stringify(sanitized)).not.toContain("credential-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts OAuth authorization codes and SAML assertions in public URLs", () => {
    const options = {
      oauth: "https://auth.example.org/callback?code=oauth-code-canary",
      saml: "https://sso.example.org/callback#SAMLResponse=saml-canary",
      assertion: "https://auth.example.org/token?client_assertion=assertion-canary",
      encoded: "https://auth.example.org/callback?%2563ode=encoded-canary",
      safe: "https://example.org/status?status_code=200&mode=read",
      code: "ordinary-source-code",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      oauth: "[REDACTED]",
      saml: "[REDACTED]",
      assertion: "[REDACTED]",
      encoded: "[REDACTED]",
      safe: options.safe,
      code: options.code,
    });
    expect(JSON.stringify(sanitized)).not.toContain("oauth-code-canary");
    expect(JSON.stringify(sanitized)).not.toContain("saml-canary");
    expect(JSON.stringify(sanitized)).not.toContain("assertion-canary");
    expect(JSON.stringify(sanitized)).not.toContain("encoded-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("preserves ordinary code settings while redacting standalone assertions and encoded keys", () => {
    const options = {
      code: "source-code-not-a-secret",
      "co%64e": "encoded-source-code-not-a-secret",
      SAMLResponse: "saml-secret-canary",
      client_assertion: "assertion-secret-canary",
      "client%255Fassertion": "nested-assertion-secret-canary",
      "SAML%2552esponse": "nested-saml-secret-canary",
      callback: "https://example.org/callback?code=oauth-secret-canary",
      safeUrl: "https://example.org/status?status_code=200",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      code: options.code,
      "co%64e": options["co%64e"],
      SAMLResponse: "[REDACTED]",
      client_assertion: "[REDACTED]",
      "client%255Fassertion": "[REDACTED]",
      "SAML%2552esponse": "[REDACTED]",
      callback: "[REDACTED]",
      safeUrl: options.safeUrl,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts OAuth and SAML credentials in hash-router callback queries", () => {
    const options = {
      oauth: "https://auth.example.org/#/callback?code=oauth-secret-canary",
      saml: "https://sso.example.org/#/callback?SAMLResponse=saml-secret-canary",
      assertion: "https://auth.example.org/#/callback?client_assertion=assertion-secret-canary",
      encoded: "https://auth.example.org/#/callback?%2563ode=encoded-secret-canary",
      safeRoute: "https://example.org/#/docs?mode=preview&status_code=200",
      safeFragment: "https://example.org/#/docs/guide",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      oauth: "[REDACTED]",
      saml: "[REDACTED]",
      assertion: "[REDACTED]",
      encoded: "[REDACTED]",
      safeRoute: options.safeRoute,
      safeFragment: options.safeFragment,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts OAuth credentials before question marks inside URL fragments", () => {
    const options = {
      callbackA: "https://example.org/#access_token=secret-canary&return_to=/docs?mode=preview",
      callbackB: "https://example.org/#code=secret-canary?state=ok",
      callbackC: "https://example.org/#client_assertion=secret-canary?state=ok",
      router: "https://example.org/#/callback?code=secret-canary",
      safeHash: "https://example.org/#/docs?mode=preview&status_code=200",
      safeNested: "https://example.org/#mode=preview&return_to=/docs?tab=ok",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      callbackA: "[REDACTED]",
      callbackB: "[REDACTED]",
      callbackC: "[REDACTED]",
      router: "[REDACTED]",
      safeHash: options.safeHash,
      safeNested: options.safeNested,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts PKCE code verifiers in options, URLs, and hash-router callbacks", () => {
    const options = {
      code_verifier: "pkce-secret-canary",
      "code%255Fverifier": "nested-pkce-secret-canary",
      tokenEndpoint: "https://auth.example.org/token?code_verifier=pkce-secret-canary",
      hashCallback: "https://auth.example.org/#/callback?code%255Fverifier=pkce-secret-canary",
      safeChallenge: "https://auth.example.org/authorize?code_challenge=public-challenge",
      code: "ordinary-source-code",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      code_verifier: "[REDACTED]",
      "code%255Fverifier": "[REDACTED]",
      tokenEndpoint: "[REDACTED]",
      hashCallback: "[REDACTED]",
      safeChallenge: options.safeChallenge,
      code: options.code,
    });
    expect(JSON.stringify(sanitized)).not.toContain("pkce-secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts protocol-relative URL credentials, including nested redirects", () => {
    const options = {
      directUserinfo: "//alice:secret-canary@private.example/skills",
      directSigned: "//private.example/skills?api_key=secret-canary",
      nestedUserinfo: "https://public.example/redirect?next=%2F%2Falice%3Asecret-canary%40private.example%2Fskills",
      nestedSigned: "https://public.example/redirect?next=%2F%2Fprivate.example%2F%3Fapi_key%3Dsecret-canary",
      malformed: "//[invalid-host",
      safeDirect: "//private.example/docs?mode=preview",
      safeNested: "https://public.example/redirect?next=%2F%2Fprivate.example%2Fdocs",
      mode: "safe",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      directUserinfo: "[REDACTED]",
      directSigned: "[REDACTED]",
      nestedUserinfo: "[REDACTED]",
      nestedSigned: "[REDACTED]",
      malformed: "[REDACTED]",
      safeDirect: options.safeDirect,
      safeNested: options.safeNested,
      mode: "safe",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("redacts credentials inside nested redirect URLs without hiding safe destinations", () => {
    const options = {
      nestedUserinfo: "https://example.org/redirect?next=https%3A%2F%2Fuser%3Apassword%40private.example%2F",
      nestedSigned: "https://example.org/redirect?next=https%3A%2F%2Fprivate.example%2F%3Fapi_key%3Dsecret-canary",
      twiceEncoded: "https://example.org/redirect?next=https%253A%252F%252Fuser%253Apassword%2540private.example%252F",
      hashRouter: "https://example.org/#/callback?next=https%3A%2F%2Fprivate.example%2F%3Fcode%3Dsecret-canary",
      safeRedirect: "https://example.org/redirect?next=https%3A%2F%2Fprivate.example%2Fdocs",
      safeEncoded: "https://example.org/redirect?next=https%253A%252F%252Fprivate.example%252Fdocs",
    };
    const config = {
      version: 1 as const,
      skillRoots: ["/workspace"],
      candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: options },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      nestedUserinfo: "[REDACTED]",
      nestedSigned: "[REDACTED]",
      twiceEncoded: "[REDACTED]",
      hashRouter: "[REDACTED]",
      safeRedirect: options.safeRedirect,
      safeEncoded: options.safeEncoded,
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex).toEqual(options);
  });

  it("fails closed when nested redirect depth or percent-decoding limits are reached", () => {
    const wrap = (url: string) => `https://redirect.example.org/?next=${encodeURIComponent(url)}`;
    const deepSecret = Array.from({ length: 4 }, () => 0).reduce(
      (url) => wrap(url), "https://private.example.org/?api_key=deep-secret-canary",
    );
    const deeplyEncoded = wrap(Array.from({ length: 7 }, () => 0).reduce(
      (url) => encodeURIComponent(url), "https://private.example.org/?api_key=encoded-secret-canary",
    ));
    const shallowSafe = wrap(wrap("https://private.example.org/docs"));
    const deepSafe = Array.from({ length: 4 }, () => 0).reduce(
      (url) => wrap(url), "https://private.example.org/docs",
    );
    const config = {
      version: 1 as const, skillRoots: ["/workspace"], candidateLimit: 10,
      adapters: ["codex"],
      adapterOptions: { codex: { deepSecret, deeplyEncoded, shallowSafe, deepSafe, mode: "safe" } },
    };
    const sanitized = sanitizeConfiguration(config);
    expect(sanitized.adapterOptions.codex).toEqual({
      deepSecret: "[REDACTED]",
      deeplyEncoded: "[REDACTED]",
      shallowSafe,
      // A fourth redirect is intentionally hidden, even if its target is safe.
      deepSafe: "[REDACTED]",
      mode: "safe",
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-canary");
    expect(config.adapterOptions.codex.deepSecret).toBe(deepSecret);
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
