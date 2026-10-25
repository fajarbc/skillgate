import { access, link, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";
import { runJson } from "./cli-json-run.js";

async function capture(invoke: () => Promise<number>) {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const exitCode = await invoke();
    const chunks = write.mock.calls.map((call) => String(call[0]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(chunks[0]?.slice(0, -1)).not.toContain("\n");
    expect(log).not.toHaveBeenCalled();
    return { exitCode, envelope: JSON.parse(chunks[0]!) };
  } finally {
    write.mockRestore();
    log.mockRestore();
  }
}

async function* stdinText(text: string) {
  yield text;
}

function validTrace(root: string) {
  return {
    id: "existing", timestamp: "2026-10-25T00:00:00Z", task: "review", root,
    signals: [], candidates: [], selectedCount: 0, rejectedCount: 0, totalEstimatedTokens: 0,
  };
}

describe("CLI v1 JSON transport integration", () => {
  it("routes scan through one versioned envelope without human stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() => run(["scan", "--root", root, "--json"]));
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      command: "scan",
      ok: true,
      data: { root, skills: [], signals: expect.any(Array) },
    });
  });

  it("keeps machine stdout isolated from stderr for success and request errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-stderr-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const success = await capture(() => run(["scan", "--root", root, "--json"]));
      expect(success.exitCode).toBe(0);
      expect(success.envelope).toMatchObject({ command: "scan", ok: true });

      const failure = await capture(() =>
        runJson(["recommend", "--json", "--stdin"], stdinText("{malformed")),
      );
      expect(failure.exitCode).toBe(1);
      expect(failure.envelope).toMatchObject({
        command: "recommend",
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts user-controlled policy errors from JSON doctor diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-doctor-"));
    const secret = "secret-policy-value-should-not-appear";
    const content = JSON.stringify({ defaultAction: secret });
    try {
      await mkdir(join(root, ".skillgate"));
      const policyFile = join(root, ".skillgate", "policy.json");
      await writeFile(policyFile, content);
      const { exitCode, envelope } = await capture(() => run(["doctor", "--json", "--root", root]));
      expect(exitCode).toBe(2);
      expect(envelope).toMatchObject({
        command: "doctor",
        ok: false,
        error: { code: "CONFIGURATION_ERROR" },
        data: { report: { status: "fail" } },
      });
      const policyCheck = envelope.data.report.checks.find(
        (check: { name: string }) => check.name === "policy-configuration",
      );
      expect(policyCheck).toMatchObject({
        status: "fail",
        message: "Policy configuration invalid",
      });
      expect(JSON.stringify(envelope)).not.toContain(secret);
      expect(await readFile(policyFile, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits user-controlled skill paths and extension names from JSON doctor diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-doctor-skills-"));
    const invalidDirectory = join(root, "private-path-canary");
    const validDirectory = join(root, "safe-skill");
    const invalidSource = "no YAML frontmatter";
    const validSource = "---\nname: safe-skill\ndescription: Example skill\nprivate-field-canary: value\n---\n";
    try {
      await mkdir(invalidDirectory);
      await mkdir(validDirectory);
      await writeFile(join(invalidDirectory, "SKILL.md"), invalidSource);
      await writeFile(join(validDirectory, "SKILL.md"), validSource);
      const { exitCode, envelope } = await capture(() => run(["doctor", "--json", "--root", root]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "doctor", ok: true, data: { report: { status: "warn" } } });
      const checks = envelope.data.report.checks;
      expect(checks.find((check: { name: string }) => check.name === "skill-discovery")).toMatchObject({
        status: "warn",
        message: "Skill discovery reported invalid or unreadable skills",
      });
      expect(checks.find((check: { name: string }) => check.name === "skill-metadata-extensions")).toMatchObject({
        status: "warn",
        message: "Skill metadata contains extension fields",
      });
      expect(JSON.stringify(envelope)).not.toContain("private-path-canary");
      expect(JSON.stringify(envelope)).not.toContain("private-field-canary");
      expect(await readFile(join(invalidDirectory, "SKILL.md"), "utf8")).toBe(invalidSource);
      expect(await readFile(join(validDirectory, "SKILL.md"), "utf8")).toBe(validSource);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts HTTP authorization, session, and credential-bearing URL values in JSON config output", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-config-redaction-"));
    const configFile = join(root, "explicit.json");
    const original = JSON.stringify({
      version: 1,
      adapterOptions: {
        codex: {
          authorization: "Bearer user-secret",
          authHeader: "user-secret",
          accessKey: "user-secret",
          cookie: "user-secret",
          sessionId: "user-secret",
          endpoint: "https://user:user-secret@example.org/v1",
          registry: "https://example.org/skills?api_key=user-secret",
          callback: "https://example.org/#access_token=user-secret",
          callbackWithQuery: "https://example.org/#access_token=user-secret&return_to=/docs?mode=preview",
          callbackCode: "https://example.org/#code=user-secret?state=ok",
          callbackAssertion: "https://example.org/#client_assertion=user-secret?state=ok",
          safeFragmentQuery: "https://example.org/#mode=preview&return_to=/docs?tab=ok",
          database: "postgresql://user:user-secret@db.example.org/main",
          malformedHttps: "https://user:user-secret@bad host/path",
          malformedDatabase: "postgresql://user:user-secret@db host/main",
          malformedSafeUrl: "https://bad host/docs",
          awsSigned: "https://storage.example.org/file?X-Amz-Signature=user-secret",
          googleSigned: "https://storage.example.org/file?X-Goog-Signature=user-secret",
          azureSigned: "https://storage.example.org/file?sig=user-secret",
          genericKey: "https://maps.example.org/?key=user-secret",
          pkceVerifier: "https://auth.example.org/token?code_verifier=user-secret",
          pkceHashCallback: "https://auth.example.org/#/callback?code%255Fverifier=user-secret",
          safeChallenge: "https://auth.example.org/authorize?code_challenge=public",
          nestedRedirect: "https://example.org/redirect?next=https%3A%2F%2Fuser%3Auser-secret%40private.example%2F",
          nestedSignedRedirect: "https://example.org/redirect?next=https%3A%2F%2Fprivate.example%2F%3Fapi_key%3Duser-secret",
          deepRedirect: Array.from({ length: 4 }).reduce(
            (url: string) => `https://redirect.example.org/?next=${encodeURIComponent(url)}`,
            "https://private.example.org/?api_key=user-secret",
          ),
          heavilyEncodedRedirect: "https://example.org/redirect?next=" +
            encodeURIComponent(Array.from({ length: 7 }).reduce(
              (url: string) => encodeURIComponent(url),
              "https://private.example.org/?api_key=user-secret",
            )),
          safeNestedRedirect: "https://example.org/redirect?next=https%3A%2F%2Fprivate.example%2Fdocs",
          safeEndpoint: "https://example.org/skills?mode=safe",
          mode: "safe",
        },
      },
    });
    try {
      await writeFile(configFile, original);
      const { exitCode, envelope } = await capture(() =>
        run(["config", "--json", "--root", root, "--config", configFile]),
      );
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({
        command: "config",
        ok: true,
        data: {
          configuration: {
            adapterOptions: {
              codex: {
                authorization: "[REDACTED]",
                authHeader: "[REDACTED]",
                accessKey: "[REDACTED]",
                cookie: "[REDACTED]",
                sessionId: "[REDACTED]",
                endpoint: "[REDACTED]",
                registry: "[REDACTED]",
                callback: "[REDACTED]",
                callbackWithQuery: "[REDACTED]",
                callbackCode: "[REDACTED]",
                callbackAssertion: "[REDACTED]",
                safeFragmentQuery: "https://example.org/#mode=preview&return_to=/docs?tab=ok",
                database: "[REDACTED]",
                malformedHttps: "[REDACTED]",
                malformedDatabase: "[REDACTED]",
                malformedSafeUrl: "[REDACTED]",
                awsSigned: "[REDACTED]",
                googleSigned: "[REDACTED]",
                azureSigned: "[REDACTED]",
                genericKey: "[REDACTED]",
                pkceVerifier: "[REDACTED]",
                pkceHashCallback: "[REDACTED]",
                safeChallenge: "https://auth.example.org/authorize?code_challenge=public",
                nestedRedirect: "[REDACTED]",
                nestedSignedRedirect: "[REDACTED]",
                deepRedirect: "[REDACTED]",
                heavilyEncodedRedirect: "[REDACTED]",
                safeNestedRedirect: "https://example.org/redirect?next=https%3A%2F%2Fprivate.example%2Fdocs",
                safeEndpoint: "https://example.org/skills?mode=safe",
                mode: "safe",
              },
            },
          },
        },
      });
      expect(JSON.stringify(envelope)).not.toContain("user-secret");
      expect(await readFile(configFile, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns one structured error for an unknown command", async () => {
    const { exitCode, envelope } = await capture(() => run(["unknown", "--json"]));
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      command: "unknown",
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("keeps malformed string options in JSON transport when followed by --json", async () => {
    // parseArgs rejects these as missing/ambiguous values. The presence of
    // --json must still produce a single structured error on stdout.
    for (const args of [
      ["scan", "--root", "--json"],
      ["scan", "--config", "--json"],
      ["recommend", "task", "--adapter", "--json"],
    ]) {
      const { exitCode, envelope } = await capture(() => run(args));
      expect(exitCode).toBe(1);
      expect(envelope).toMatchObject({
        protocolVersion: 1,
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
  });

  it("returns structured errors for malformed --json=value options", async () => {
    const humanError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const flag of ["--json=true", "--json=false", "--json="]) {
        const { exitCode, envelope } = await capture(() => run(["scan", flag]));
        expect(exitCode).toBe(1);
        expect(envelope).toMatchObject({
          protocolVersion: 1,
          command: null,
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(humanError).not.toHaveBeenCalled();
    } finally {
      humanError.mockRestore();
    }
  });

  it("preserves a multiline stdin task without shell quoting", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const task = "Investigate the regression\nThen verify 日本語 🚀";
    const input = JSON.stringify({ protocolVersion: 1, task, context: { paths: ["src/cli.ts"] } });
    const { exitCode, envelope } = await capture(() =>
      runJson(["recommend", "--json", "--stdin", "--root", root], stdinText(input)),
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      command: "recommend",
      ok: true,
      data: { task, recommendations: expect.any(Array) },
    });
  });

  it("fills candidateLimit from permitted skills instead of letting denied top matches crowd them out", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-policy-limit-"));
    try {
      const denied = join(root, "skills", "typescript");
      const allowed = join(root, "skills", "lint-helper");
      await mkdir(denied, { recursive: true });
      await mkdir(allowed, { recursive: true });
      await mkdir(join(root, ".skillgate"));
      await writeFile(join(denied, "SKILL.md"),
        "---\nname: typescript\ndescription: TypeScript expertise\n---\n");
      await writeFile(join(allowed, "SKILL.md"),
        "---\nname: lint-helper\ndescription: TypeScript lint assistance\n---\n");
      await writeFile(join(root, "skillgate.yaml"), "version: 1\ncandidateLimit: 1\n");
      const policyFile = join(root, ".skillgate", "policy.json");
      const policy = JSON.stringify({ deniedSkills: ["typescript"] });
      await writeFile(policyFile, policy);

      const { exitCode, envelope } = await capture(() =>
        run(["recommend", "typescript", "--root", root, "--json"]),
      );
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({
        command: "recommend",
        ok: true,
        data: { recommendations: [{ metadata: { name: "lint-helper" } }] },
      });
      expect(envelope.data.recommendations).toHaveLength(1);
      expect(JSON.stringify(envelope)).not.toContain('"name":"typescript"');
      expect(await readFile(policyFile, "utf8")).toBe(policy);
      await expect(access(join(root, ".skillgate", "trace.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a managed trace directory for JSON recommendations", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() =>
      run(["recommend", "inspect safety", "--root", root, "--json"]),
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({ command: "recommend", ok: true });
    await expect(access(join(root, ".skillgate"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a user-owned file behind a trace symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const managed = join(root, ".skillgate");
    const sentinel = join(root, "user-owned.txt");
    await mkdir(managed);
    await writeFile(sentinel, "keep user content", "utf8");
    await symlink(sentinel, join(managed, "trace.json"));
    const { exitCode, envelope } = await capture(() =>
      run(["recommend", "inspect safety", "--root", root, "--json"]),
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({ command: "recommend", ok: true });
    expect(await readFile(sentinel, "utf8")).toBe("keep user content");
  });

  it("fails closed on machine adapter application until #28 safety is validated", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() =>
      run(["recommend", "test", "--json", "--adapter", "codex", "--root", root]),
    );
    expect(exitCode).toBe(3);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      command: "recommend",
      ok: false,
      error: { code: "ADAPTER_CONFLICT" },
    });
    await expect(access(join(root, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, ".skillgate"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for an explicitly empty machine adapter option", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() =>
      run(["recommend", "test", "--json", "--adapter", "", "--root", root]),
    );
    expect(exitCode).toBe(3);
    expect(envelope).toMatchObject({
      command: "recommend",
      ok: false,
      error: { code: "ADAPTER_CONFLICT" },
    });
    await expect(access(join(root, ".skillgate"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects even an empty adapter option on non-recommend JSON commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() =>
      run(["scan", "--json", "--adapter", "", "--root", root]),
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({
      command: "scan",
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects unsupported stdin protocol versions with a stable code", async () => {
    const { exitCode, envelope } = await capture(() =>
      runJson(["recommend", "--json", "--stdin"], stdinText('{"protocolVersion":2,"task":"test"}')),
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({
      command: "recommend",
      ok: false,
      error: { code: "UNSUPPORTED_PROTOCOL" },
    });
  });

  it("rejects conflicting stdin and positional task text before reading input", async () => {
    const { exitCode, envelope } = await capture(() =>
      runJson(["recommend", "positional", "--json", "--stdin"], stdinText("{}")),
    );
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({
      command: "recommend",
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("rejects malformed JSON without echoing input or stack traces", async () => {
    const { exitCode, envelope } = await capture(() =>
      runJson(["recommend", "--json", "--stdin"], stdinText('{"task":"secret-token"')),
    );
    expect(exitCode).toBe(1);
    expect(envelope.error.code).toBe("INVALID_REQUEST");
    expect(JSON.stringify(envelope)).not.toContain("secret-token");
    expect(JSON.stringify(envelope)).not.toContain("stack");
  });

  it.each([
    ['"user-owned-secret"', "string"],
    ["[1, 2, 3]", "array"],
    ["42", "number"],
    ["true", "boolean"],
  ])("treats a %s machine trace value as absent instead of violating the schema (%s)", async (content) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      await writeFile(file, content);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(JSON.stringify(envelope)).not.toContain("user-owned-secret");
      expect(await readFile(file, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['{"secret":"user-owned-secret"}', "unrelated object"],
    ['{"id":"partial","task":"review"}', "incomplete trace"],
    ['{"id":"x","timestamp":"now","task":"review","root":"/","signals":[],"candidates":[],"selectedCount":-1,"rejectedCount":0,"totalEstimatedTokens":0}', "negative count"],
    ['{"id":"x","timestamp":"now","task":"review","root":"/","signals":{},"candidates":[],"selectedCount":0,"rejectedCount":0,"totalEstimatedTokens":0}', "invalid signals"],
  ])("treats a %s as absent instead of exposing a foreign machine trace (%s)", async (content) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      await writeFile(file, content);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(JSON.stringify(envelope)).not.toContain("user-owned-secret");
      expect(await readFile(file, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects nested trace fields without leaking unrelated properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      const record = {
        id: "existing", timestamp: "2026-10-25T00:00:00Z", task: "review", root,
        signals: [{ kind: "framework", name: "react", evidence: "package.json", secret: "nested-secret" }],
        candidates: [{
          path: "/skills/react/SKILL.md", name: "react", description: "React skill",
          status: "selected", decisionReason: "ranked", score: 5,
          reasons: [{ source: "name", term: "react", points: 5, secret: "reason-secret" }],
          estimatedTokens: 3, policyDecision: "allow", secret: "candidate-secret",
        }],
        selectedCount: 1, rejectedCount: 0, totalEstimatedTokens: 3,
        secret: "root-secret",
      };
      const original = JSON.stringify(record);
      await writeFile(file, original);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({
        command: "trace", ok: true,
        data: { trace: { id: "existing", selectedCount: 1, signals: [{ name: "react" }] } },
      });
      expect(JSON.stringify(envelope)).not.toContain("-secret");
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid signal", { signals: ["secret-signal"] }],
    ["invalid candidate", { candidates: ["secret-candidate"], selectedCount: 0, rejectedCount: 1 }],
    ["invalid reason", { candidates: [{
      path: "/skill", name: "skill", description: "desc", status: "selected",
      decisionReason: "ranked", score: 1, reasons: ["secret-reason"], estimatedTokens: 2,
    }], selectedCount: 1, totalEstimatedTokens: 2 }],
    ["mismatched counters", { selectedCount: 1 }],
  ])("rejects a machine trace with %s", async (_label, changes) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      const record = {
        id: "existing", timestamp: "2026-10-25T00:00:00Z", task: "review", root,
        signals: [], candidates: [], selectedCount: 0, rejectedCount: 0, totalEstimatedTokens: 0,
        ...changes,
      };
      const original = JSON.stringify(record);
      await writeFile(file, original);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(JSON.stringify(envelope)).not.toContain("secret-");
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads an unchanged regular JSON trace without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      const content = JSON.stringify({ id: "existing", timestamp: "2026-10-25T00:00:00Z", task: "review", root, signals: [], candidates: [], selectedCount: 0, rejectedCount: 0, totalEstimatedTokens: 0 });
      await writeFile(file, content);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: { id: "existing" } } });
      expect(await readFile(file, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked machine trace into user-owned JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const sentinel = join(root, "user-owned.json");
      // A valid trace would be returned if the symlink guard were bypassed.
      const content = JSON.stringify({ ...validTrace(root), secret: "do-not-expose" });
      await writeFile(sentinel, content);
      await symlink(sentinel, join(root, ".skillgate", "trace.json"));
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(JSON.stringify(envelope)).not.toContain("do-not-expose");
      expect(await readFile(sentinel, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a hardlinked machine trace even when its JSON is valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const sentinel = join(root, "user-owned.json");
      const content = JSON.stringify(validTrace(root));
      await writeFile(sentinel, content);
      await link(sentinel, join(root, ".skillgate", "trace.json"));
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(await readFile(sentinel, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked .skillgate directory containing a valid trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      const external = join(root, "user-owned-dir");
      await mkdir(external);
      const content = JSON.stringify(validTrace(root));
      await writeFile(join(external, "trace.json"), content);
      await symlink(external, join(root, ".skillgate"), "dir");
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(await readFile(join(external, "trace.json"), "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed UTF-8 trace bytes without rewriting the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      const content = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
      await writeFile(file, content);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
      expect(await readFile(file)).toEqual(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized trace data before reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      await writeFile(file, "{}");
      await truncate(file, 32 * 1024 * 1024 + 1);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects FIFO trace paths without blocking", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-trace-"));
    try {
      await mkdir(join(root, ".skillgate"));
      const file = join(root, ".skillgate", "trace.json");
      const created = spawnSync("mkfifo", [file], { timeout: 3000 });
      if ((created.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      expect(created.status).toBe(0);
      const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
      expect(exitCode).toBe(0);
      expect(envelope).toMatchObject({ command: "trace", ok: true, data: { trace: null } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an absent trace as a successful nullable trace field", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-json-"));
    const { exitCode, envelope } = await capture(() => run(["trace", "--root", root, "--json"]));
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      protocolVersion: 1,
      command: "trace",
      ok: true,
      data: { trace: null },
    });
  });
});
