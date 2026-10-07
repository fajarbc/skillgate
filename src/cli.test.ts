import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
});
