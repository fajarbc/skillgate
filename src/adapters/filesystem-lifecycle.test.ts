import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFilesystemAdapter, cleanupFilesystemAdapter, planFilesystemAdapter } from "./filesystem-lifecycle.js";

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

  it("refuses symlinked destination files before plan or apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-symlink-"));
    try {
      const destDir = join(root, ".codex", "skills", "example");
      const outside = join(root, "user-owned.md");
      await mkdir(destDir, { recursive: true });
      await writeFile(outside, "preserve me");
      await symlink(outside, join(destDir, "SKILL.md"));
      const context = {
        task: "test",
        root,
        skills: [{
          path: join(root, "source.md"),
          metadata: { name: "example", description: "Example" },
          score: 1,
          reasons: [],
        }],
      };
      await expect(planFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlinked managed file/);
      await expect(applyFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlinked managed file/);
      expect(await readFile(outside, "utf8")).toBe("preserve me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked ancestor directories during planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-parent-symlink-"));
    try {
      const outside = join(root, "user-owned");
      await mkdir(outside);
      await mkdir(join(root, ".codex"));
      await symlink(outside, join(root, ".codex", "skills"), "dir");
      const context = {
        task: "test", root,
        skills: [{
          path: join(root, "source.md"),
          metadata: { name: "example", description: "Example" },
          score: 1, reasons: [],
        }],
      };
      await expect(planFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlink/i);
      await expect(applyFilesystemAdapter("codex", ".codex", context))
        .rejects.toThrow(/symlink/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove a stale user-owned skill claimed by a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-ownership-"));
    try {
      const target = join(root, ".codex", "skills", "personal", "SKILL.md");
      await mkdir(join(root, ".codex", "skills", "personal"), { recursive: true });
      await writeFile(target, "personal");
      await writeFile(join(root, ".codex", "skills.json"), JSON.stringify({
        managedBy: "skillgate", managedFiles: [target], skills: [],
      }));
      const context = { task: "", root, skills: [] };
      expect((await planFilesystemAdapter("codex", ".codex", context)).conflicts).toContain(target);
      await expect(cleanupFilesystemAdapter("codex", ".codex", context)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("personal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
