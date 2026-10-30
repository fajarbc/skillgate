import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";

describe("CLI", () => {
  it("prints the version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith("0.0.0");
    log.mockRestore();
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

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["scan", "--root", root, "--json"])).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output.skills[0].metadata.name).toBe("testing");
    expect(output.signals).toEqual(expect.arrayContaining([expect.objectContaining({ name: "typescript" })]));
    log.mockRestore();
  });

  it("recommends matching skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["recommend", "test", "react", "--root", root, "--json"])).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output.recommendations[0].metadata.name).toBe("react-testing");
    log.mockRestore();
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

  it("persists trace during recommend and displays with trace command", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["recommend", "test", "react", "--root", root])).toBe(0);

    expect(await run(["trace", "--root", root, "--json"])).toBe(0);
    const traceJson = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(traceJson.task).toBe("test react");
    expect(traceJson.selectedCount).toBe(1);
    expect(traceJson.candidates[0].name).toBe("react-testing");
    log.mockRestore();
  });

  it("filters out policy-denied skills during recommend", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");
    await writeFile(
      join(root, "skillgate.policy.json"),
      JSON.stringify({ deniedSkills: ["react-*"] }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(["recommend", "test", "react", "--root", root, "--json"])).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(output.recommendations).toHaveLength(0);

    expect(await run(["trace", "--root", root, "--json"])).toBe(0);
    const traceJson = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const rejected = traceJson.candidates.find((c: { name: string }) => c.name === "react-testing");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.decisionReason).toContain("denied by policy");
    log.mockRestore();
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const exitCode = await run(["doctor", "--root", root, "--json"]);
    expect(exitCode).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report.checks.length).toBeGreaterThan(0);
    log.mockRestore();
  });
  it("honors the configured policy path", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cli-policy-"));
    await mkdir(join(root, "skills", "react"), { recursive: true });
    await writeFile(join(root, "skills", "react", "SKILL.md"), "---\nname: react-testing\ndescription: Test React components\n---\n");
    await writeFile(join(root, "restricted.json"), JSON.stringify({ deniedSkills: ["react-*"] }));
    await writeFile(join(root, "skillgate.yaml"), "version: 1\npolicyPath: ./restricted.json\n");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "test", "react", "--root", root, "--json"])).toBe(0);
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(output.recommendations).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
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
