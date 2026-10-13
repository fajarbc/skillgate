import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupFilesystemAdapter, planFilesystemAdapter } from "./filesystem-lifecycle.js";

describe("filesystem adapter manifest boundaries", () => {
  it("refuses cleanup paths outside the managed skills directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-boundary-"));
    try {
      const outside = join(root, "user-owned.txt");
      const agentRoot = join(root, ".codex");
      await mkdir(agentRoot, { recursive: true });
      await writeFile(outside, "preserve me");
      await writeFile(join(agentRoot, "skills.json"), JSON.stringify({
        managedBy: "skillgate",
        version: "1.0",
        managedFiles: [outside],
        skills: [],
      }));
      const context = { task: "", root, skills: [] };
      await expect(planFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/Managed file is outside/);
      await expect(cleanupFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/Managed file is outside/);
      expect(await readFile(outside, "utf8")).toBe("preserve me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects symlinked ownership manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-symlink-"));
    try {
      const agentRoot = join(root, ".codex");
      await mkdir(agentRoot, { recursive: true });
      const outside = join(root, "user-owned.json");
      await writeFile(outside, JSON.stringify({ managedBy: "skillgate", managedFiles: [] }));
      await symlink(outside, join(agentRoot, "skills.json"));
      const context = { task: "", root, skills: [] };
      await expect(planFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlinked managed file/);
      await expect(cleanupFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlinked managed file/);
      expect(await readFile(outside, "utf8")).toContain("managedBy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
