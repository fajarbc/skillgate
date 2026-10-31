import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Model an adapter that returns success. The production strict adapters
// currently reject before mutation, so the successful branch needs a stub.
vi.mock("./adapters/index.js", () => ({
  getAdapter: (name: string) => name === "codex" ? {
    name: "codex", apply: async () => ({ summary: "mock apply succeeded" }),
  } : undefined,
  listAdapters: () => ["codex"],
}));

import { run } from "./cli.js";

describe("successful adapter CLI trace isolation", () => {
  it("does not overwrite a user-owned trace symlink target after successful apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-adapter-trace-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await mkdir(join(root, "skills", "react"), { recursive: true });
      await writeFile(join(root, "skills", "react", "SKILL.md"),
        "---\nname: react-testing\ndescription: Test React components\n---\n");
      await mkdir(join(root, ".skillgate"));
      const sentinel = join(root, "user-owned.txt");
      const trace = join(root, ".skillgate", "trace.json");
      await writeFile(sentinel, "USER-OWNED TRACE");
      await symlink(sentinel, trace);

      expect(await run(["recommend", "test", "react", "--root", root, "--adapter", "codex"])).toBe(0);
      assert.equal(await readFile(sentinel, "utf8"), "USER-OWNED TRACE");
      expect((await lstat(trace)).isSymbolicLink()).toBe(true);
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a legacy trace directory on successful adapter apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-adapter-trace-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await run(["recommend", "task", "--root", root, "--adapter", "codex"])).toBe(0);
      await expect(lstat(join(root, ".skillgate"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
