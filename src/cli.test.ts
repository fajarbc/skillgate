import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";

async function captureJson(argv: string[]): Promise<any> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await run(argv)).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    return JSON.parse(String(write.mock.calls[0]?.[0])).data;
  } finally {
    write.mockRestore();
  }
}

describe("CLI", () => {
  it("prints the version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith("0.0.0");
    log.mockRestore();
  });

  it("shows JSON and stdin options on separate help lines", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await run(["--help"])).toBe(0);
      const help = String(log.mock.calls[0]?.[0]);
      expect(help).toMatch(/--json[^\n]*\n\s*--stdin/);
    } finally {
      log.mockRestore();
    }
  });

  it("preserves literal --json task text after -- in human mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "--root", root, "--", "--json"])).toBe(0);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    const trace = (await captureJson(["trace", "--root", root, "--json"])).trace;
    expect(trace.task).toBe("--json");
  });

  it("still recognizes --json before -- with literal task text", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    const output = await captureJson(["recommend", "--json", "--root", root, "--", "--json"]);
    expect(output.task).toBe("--json");
  });

  it("rejects unknown commands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await run(["wat"])).toBe(1);
    error.mockRestore();
  });

  it("scans skills and project signals as JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "test"), { recursive: true });
    await writeFile(join(root, "skills", "test", "SKILL.md"), "---\nname: testing\ndescription: Test TypeScript code\n---\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "5.7.0" } }));

    const output = await captureJson(["scan", "--root", root, "--json"]);
    expect(output.skills[0].metadata.name).toBe("testing");
    expect(output.signals).toEqual(expect.arrayContaining([expect.objectContaining({ name: "typescript" })]));
  });

  it("recommends matching skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");

    const output = await captureJson(["recommend", "test", "react", "--root", root, "--json"]);
    expect(output.recommendations[0].metadata.name).toBe("react-testing");
  });

  it("requires task text for recommend", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await run(["recommend", "--root", root])).toBe(1);
    expect(error).toHaveBeenCalledWith("recommend requires task text");
    error.mockRestore();
  });

  it("handles trace command when no trace exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["trace", "--root", root])).toBe(0);
    expect(log).toHaveBeenCalledWith("No trace found. Run `skillgate recommend` first.");
    log.mockRestore();
  });

  it("does not expose symlinked or malformed foreign JSON in human trace output", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-human-trace-"));
    const directory = join(root, ".skillgate");
    const trace = join(directory, "trace.json");
    const foreign = join(root, "private.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(directory);
      await writeFile(foreign, JSON.stringify({
        id: "private-trace", timestamp: "2026-10-01T00:00:00Z",
        task: "SECRET TASK", root: "/private",
        signals: [], candidates: [],
        selectedCount: 0, rejectedCount: 0, totalEstimatedTokens: 0,
      }));
      await symlink(foreign, trace);
      expect(await run(["trace", "--root", root])).toBe(0);
      expect(log).toHaveBeenCalledWith("No trace found. Run `skillgate recommend` first.");
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET TASK");

      await rm(trace);
      await writeFile(trace, JSON.stringify({ id: "foreign", task: "SECRET TASK" }));
      log.mockClear();
      expect(await run(["trace", "--root", root])).toBe(0);
      expect(log).toHaveBeenCalledWith("No trace found. Run `skillgate recommend` first.");
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET TASK");
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists trace during recommend and displays with trace command", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["recommend", "test", "react", "--root", root])).toBe(0);

    log.mockRestore();
    const traceJson = (await captureJson(["trace", "--root", root, "--json"])).trace;
    expect(traceJson.task).toBe("test react");
    expect(traceJson.selectedCount).toBe(1);
    expect(traceJson.candidates[0].name).toBe("react-testing");
  });

  it("filters out policy-denied skills during recommend", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({ deniedSkills: ["react-*"] }),
    );

    const output = await captureJson(["recommend", "test", "react", "--root", root, "--json"]);
    expect(output.recommendations).toHaveLength(0);
    // Machine recommendations intentionally do not persist traces until the
    // lifecycle write boundary is accepted. Do not expect a trace from JSON mode.
    expect((await captureJson(["trace", "--root", root, "--json"])).trace).toBeNull();

    // The human CLI still records a trace, including policy rejections.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "test", "react", "--root", root])).toBe(0);
    } finally {
      log.mockRestore();
    }
    const traceJson = (await captureJson(["trace", "--root", root, "--json"])).trace;
    const rejected = traceJson.candidates.find((c: { name: string }) => c.name === "react-testing");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.decisionReason).toContain("denied by policy");
  });

  it("exits with non-zero when policy file is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await writeFile(join(root, "skillgate.policy.json"), "{ invalid json");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await run(["recommend", "test", "--root", root])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Failed to parse policy JSON"));
    error.mockRestore();
  });

  it("fails closed before changing an existing trace or Codex files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");
    await mkdir(join(root, ".skillgate"), { recursive: true });
    const trace = join(root, ".skillgate", "trace.json");
    await writeFile(trace, "USER-OWNED TRACE");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "test", "react", "--root", root, "--adapter", "codex"])).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Strict external-writer lifecycle safety"));
      expect(await readFile(trace, "utf8")).toBe("USER-OWNED TRACE");
      await expect(readFile(join(root, ".codex", "skills", "react-testing", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      error.mockRestore();
    }
  });

  it("fails closed without creating a trace or Claude files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "test", "react", "--root", root, "--adapter", "claude"])).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Strict external-writer lifecycle safety"));
      await expect(readFile(join(root, ".skillgate", "trace.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, ".claude", "skills", "react-testing", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      error.mockRestore();
    }
  });

  it("executes doctor command for healthy workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    const report = (await captureJson(["doctor", "--root", root, "--json"])).report;
    expect(report.checks.length).toBeGreaterThan(0);
  });
  it("honors the configured policy path", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-policy-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");
    await writeFile(join(root, "restricted.json"), JSON.stringify({ deniedSkills: ["react-*"] }));
    await writeFile(join(root, "skillgate.yaml"), "version: 1\npolicyPath: ./restricted.json\n");

    const output = await captureJson(["recommend", "test", "react", "--root", root, "--json"]);
    expect(output.recommendations).toHaveLength(0);
  });

  it("rejects an explicitly empty adapter before overwriting a legacy trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-empty-adapter-"));
    await mkdir(join(root, ".skillgate"), { recursive: true });
    const trace = join(root, ".skillgate", "trace.json");
    await writeFile(trace, "USER-OWNED TRACE");

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const adapterArgs of [["--adapter", ""], ["--adapter="], ["--adapter", " "]]) {
        expect(await run(["recommend", "test", "--root", root, ...adapterArgs])).toBe(1);
        expect(error).toHaveBeenCalledWith("Adapter name must not be empty");
        expect(await readFile(trace, "utf8")).toBe("USER-OWNED TRACE");
      }
    } finally {
      error.mockRestore();
    }
  });

  it("rejects adapters excluded by configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-adapters-"));
    await writeFile(join(root, "skillgate.yaml"), "version: 1\nadapters: [claude]\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "test", "--root", root, "--adapter", "codex"])).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("not enabled"));
    } finally {
      error.mockRestore();
    }
  });

});
