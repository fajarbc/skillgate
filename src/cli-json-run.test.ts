import { mkdtemp } from "node:fs/promises";
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
