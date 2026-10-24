import { access, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
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
      const content = JSON.stringify({ secret: "do-not-expose" });
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
