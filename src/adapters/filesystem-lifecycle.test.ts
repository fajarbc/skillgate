import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPreviousManifest, isManagedFile, OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";
import { CodexAdapter } from "./codex.js";

describe("adapter ownership manifest validation", () => {
  it("preserves edited managed files with intact ownership markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-digest-"));
    try {
      const dir = join(root, ".codex", "skills", "sample");
      await mkdir(dir, { recursive: true });
      const source = join(root, "source.md");
      await writeFile(source, "# Original");
      const adapter = new CodexAdapter();
      const context = { task: "digest", root, skills: [{ path: source, score: 1, metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      await adapter.apply(context);
      const target = join(dir, "SKILL.md");
      await writeFile(target, OWNERSHIP_HEADER + "# User edited");
      expect((await adapter.plan(context)).conflicts).toContain(target);
      await expect(adapter.apply(context)).rejects.toThrow();
      await adapter.cleanup(context);
      expect(await readFile(target, "utf8")).toBe(OWNERSHIP_HEADER + "# User edited");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("requires an ownership header even for a manifest-listed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-ownership-"));
    try {
      const path = join(root, "SKILL.md");
      await writeFile(path, "# User-authored content");
      const manifest = { managedBy: "skillgate" as const, version: "1.0" as const,
        agent: "codex", task: "test", updatedAt: "2026-01-01",
        managedFiles: [path], skills: [] };
      expect(await isManagedFile(path, manifest)).toBe(false);
      await writeFile(path, OWNERSHIP_HEADER + "# Managed");
      expect(await isManagedFile(path, manifest)).toBe(true);
      expect(await isManagedFile(path, { ...manifest, managedFiles: [] })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    { agent: "claude-code", version: "1.0", expected: "codex" },
    { agent: "codex", version: "2.0", expected: "codex" },
    { agent: "codex", version: "1.0", expected: "codex" },
  ])("accepts only the supported version for the expected adapter: $agent/$version", async ({ agent, version, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-manifest-validation-"));
    try {
      const path = join(root, "skills.json");
      const manifest = {
        managedBy: "skillgate", version, agent, task: "test",
        updatedAt: "2026-01-01", managedFiles: [path], skills: [],
      };
      await writeFile(path, JSON.stringify(manifest));
      const loaded = await readPreviousManifest(path, expected);
      if (agent === expected && version === "1.0") {
        expect(loaded).toEqual(manifest);
      } else {
        expect(loaded).toBeNull();
      }
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not trust another adapter manifest to remove Codex files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-foreign-"));
    try {
      const dir = join(root, ".codex", "skills", "example");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      await writeFile(target, OWNERSHIP_HEADER + "# User");
      const manifest = JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "claude-code",
        task: "old", updatedAt: "2026-01-01",
        managedFiles: [target, manifestPath], skills: [],
      });
      await writeFile(manifestPath, manifest);
      const adapter = new CodexAdapter();
      const context = { task: "new", root, skills: [] };
      expect((await adapter.plan(context)).conflicts).toContain(manifestPath);
      await expect(adapter.apply(context)).rejects.toThrow();
      expect((await adapter.cleanup(context)).filesRemoved).toEqual([]);
      expect(await readFile(target, "utf8")).toBe(OWNERSHIP_HEADER + "# User");
      expect(await readFile(manifestPath, "utf8")).toBe(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers managed files from an interrupted apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-recovery-"));
    try {
      const dir = join(root, ".codex", "skills", "existing");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      const missing = join(root, ".codex", "skills", "pending", "SKILL.md");
      await writeFile(target, OWNERSHIP_HEADER + "# Managed");
      await writeFile(manifestPath, JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "interrupted", updatedAt: "2026-01-01",
        managedFiles: [target, missing, manifestPath], skills: [],
      }));
      const result = await new CodexAdapter().cleanup({ task: "recover", root, skills: [] });
      expect(result.filesRemoved).toContain(target);
      expect(result.filesRemoved).toContain(manifestPath);
      expect(result.filesRemoved).not.toContain(missing);
      await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
