import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPreviousManifest, isManagedFile, OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";

describe("adapter ownership manifest validation", () => {
  it("rejects ownership evidence through a symlinked parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-parent-symlink-"));
    try {
      const real = join(root, "real");
      const alias = join(root, "alias");
      await mkdir(real);
      await symlink(real, alias, "dir");
      const manifest = {
        managedBy: "skillgate" as const, version: "1.0" as const,
        agent: "codex", managedFiles: [], skills: [],
      };
      await writeFile(join(real, "skills.json"), JSON.stringify(manifest));
      expect(await readPreviousManifest(join(real, "skills.json"), "codex")).toEqual(manifest);
      expect(await readPreviousManifest(join(alias, "skills.json"), "codex")).toBeNull();

      const content = OWNERSHIP_HEADER + "# owned";
      await writeFile(join(real, "SKILL.md"), content);
      const ownedPath = join(alias, "SKILL.md");
      expect(await isManagedFile(ownedPath, {
        ...manifest,
        managedFiles: [ownedPath],
        fileDigests: { [ownedPath]: createHash("sha256").update(content).digest("hex") },
      })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept ownership metadata through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-symlink-manifest-"));
    try {
      const target = join(root, "real.json");
      const alias = join(root, "skills.json");
      await writeFile(target, JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex",
        managedFiles: [], skills: [],
      }));
      await symlink(target, alias);
      expect(await readPreviousManifest(alias, "codex")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept managed files through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-symlink-file-"));
    try {
      const target = join(root, "real.md");
      const alias = join(root, "SKILL.md");
      const content = OWNERSHIP_HEADER + "# managed";
      await writeFile(target, content);
      await symlink(target, alias);
      expect(await isManagedFile(alias, {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        managedFiles: [alias], skills: [],
        fileDigests: { [alias]: createHash("sha256").update(content).digest("hex") },
      })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed UTF-8 in an otherwise valid ownership manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-manifest-utf8-"));
    try {
      const manifestPath = join(root, "skills.json");
      const valid = {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "unicode", updatedAt: "2026-10-19T00:00:00.000Z",
        managedFiles: [], skills: [],
      };
      const bytes = Buffer.from(JSON.stringify(valid));
      await writeFile(manifestPath, Buffer.concat([bytes.subarray(0, bytes.length - 1),
        Buffer.from([0xff]), bytes.subarray(bytes.length - 1)]));
      expect(await readPreviousManifest(manifestPath, "codex")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a managed file whose invalid UTF-8 bytes replace a replacement character", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-byte-ownership-"));
    try {
      const target = join(root, "SKILL.md");
      const original = Buffer.from(OWNERSHIP_HEADER + "\uFFFD");
      await writeFile(target, original);
      const manifest = {
        managedBy: "skillgate" as const, version: "1.0" as const,
        agent: "codex", task: "bytes", updatedAt: new Date().toISOString(),
        managedFiles: [target], fileDigests: {
          [target]: createHash("sha256").update(original).digest("hex"),
        }, skills: [],
      };
      expect(await isManagedFile(target, manifest)).toBe(true);
      await writeFile(target, Buffer.concat([Buffer.from(OWNERSHIP_HEADER), Buffer.from([0xff])]));
      expect(await readFile(target, "utf8")).toBe(OWNERSHIP_HEADER + "\uFFFD");
      expect(await isManagedFile(target, manifest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes parallel applies targeting the same adapter root", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-locked-apply-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Managed");
      const context = { task: "locked", root, skills: [{ path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      const adapter = new CodexAdapter();
      const results = await Promise.all(Array.from({ length: 4 }, () => adapter.apply(context)));
      expect(results).toHaveLength(4);
      expect(results.every((result) => result.filesWritten.length > 0)).toBe(true);
      expect(await readPreviousManifest(join(root, ".codex", "skills.json"), "codex")).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for an existing adapter lock before touching the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-locked-wait-"));
    const lockPath = join(tmpdir(), `skillgate-adapter-${createHash("sha256").update(join(root, ".codex")).digest("hex")}.lock`);
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Managed");
      const context = { task: "locked", root, skills: [{ path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      await mkdir(lockPath);
      const apply = new CodexAdapter().apply(context);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await readPreviousManifest(join(root, ".codex", "skills.json"), "codex")).toBeNull();
      await rmdir(lockPath);
      expect((await apply).filesWritten.length).toBeGreaterThan(0);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves edited managed files with intact ownership markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-digest-"));
    try {
      const dir = join(root, ".codex", "skills", "sample");
      await mkdir(dir, { recursive: true });
      const source = join(root, "source.md");
      await writeFile(source, "# Original");
      const adapter = new CodexAdapter();
      const context = { task: "digest", root, skills: [{ path: source, score: 1, reasons: [], metadata: { name: "sample", description: "sample", capabilities: [] } }] };
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

  it("refuses to overwrite an untracked file even when it carries the ownership header", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-untracked-destination-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const destination = join(root, ".codex", "skills", "sample", "SKILL.md");
      await mkdir(join(root, ".codex", "skills", "sample"), { recursive: true });
      const userContent = OWNERSHIP_HEADER + "# User-owned";
      await writeFile(destination, userContent);
      const context = {
        task: "untracked", root,
        skills: [{ path: source, score: 1, reasons: [],
          metadata: { name: "sample", description: "sample", capabilities: [] } }],
      };
      const adapter = new CodexAdapter();
      expect((await adapter.plan(context)).conflicts).toContain(destination);
      await expect(adapter.apply(context)).rejects.toThrow();
      expect(await readFile(destination, "utf8")).toBe(userContent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust an untracked file merely because it has an ownership marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-untracked-marker-"));
    try {
      const path = join(root, "SKILL.md");
      await writeFile(path, OWNERSHIP_HEADER + "# User-created");
      expect(await isManagedFile(path, null)).toBe(false);
      const manifest = {
        managedBy: "skillgate" as const, version: "1.0" as const,
        agent: "codex", task: "test", updatedAt: "2026-01-01",
        managedFiles: [path], fileDigests: {}, skills: [],
      };
      expect(await isManagedFile(path, manifest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a completed pending write only when its expected digest matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-pending-digest-"));
    try {
      const dir = join(root, ".codex", "skills", "pending");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      const original = OWNERSHIP_HEADER + "# Managed";
      const expectedDigest = createHash("sha256").update(original).digest("hex");
      const manifest = {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "interrupted", updatedAt: "2026-01-01",
        managedFiles: [target, manifestPath],
        fileDigests: { [target]: expectedDigest }, skills: [],
      };
      await writeFile(target, OWNERSHIP_HEADER + "# User changed");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const adapter = new CodexAdapter();
      const context = { task: "recover", root, skills: [] };
      const first = await adapter.cleanup(context);
      expect(first.filesRemoved).not.toContain(target);
      expect(await readFile(target, "utf8")).toBe(OWNERSHIP_HEADER + "# User changed");
      await writeFile(target, original);
      const second = await adapter.cleanup(context);
      expect(second.filesRemoved).toContain(target);
      expect(second.filesRemoved).toContain(manifestPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers the previous managed bytes after an interrupted update", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-pending-previous-"));
    try {
      const dir = join(root, ".codex", "skills", "sample");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      const oldContent = OWNERSHIP_HEADER + "# Old";
      const hash = (content: string) => createHash("sha256").update(content).digest("hex");
      await writeFile(target, oldContent);
      await writeFile(manifestPath, JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex", task: "interrupted",
        updatedAt: "2026-01-01", managedFiles: [target, manifestPath],
        fileDigests: { [target]: hash(OWNERSHIP_HEADER + "# New") },
        previousFileDigests: { [target]: hash(oldContent) }, phase: "pending", skills: [],
      }));
      const result = await new CodexAdapter().cleanup({ task: "cleanup", root, skills: [] });
      expect(result.filesRemoved).toContain(target);
      expect(result.filesRemoved).toContain(manifestPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves user edits and ignores previous digests in final manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-pending-edited-"));
    try {
      const dir = join(root, ".codex", "skills", "sample");
      await mkdir(dir, { recursive: true });
      const target = join(dir, "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      const hash = (content: string) => createHash("sha256").update(content).digest("hex");
      const oldContent = OWNERSHIP_HEADER + "# Old";
      const edited = OWNERSHIP_HEADER + "# User changed";
      const pending = {
        managedBy: "skillgate" as const, version: "1.0" as const, agent: "codex",
        task: "interrupted", updatedAt: "2026-01-01", managedFiles: [target, manifestPath],
        fileDigests: { [target]: hash(OWNERSHIP_HEADER + "# New") },
        previousFileDigests: { [target]: hash(oldContent) }, phase: "pending" as const,
        skills: [],
      };
      await writeFile(target, edited);
      await writeFile(manifestPath, JSON.stringify(pending));
      expect(await isManagedFile(target, pending)).toBe(false);
      const result = await new CodexAdapter().cleanup({ task: "cleanup", root, skills: [] });
      expect(result.filesRemoved).not.toContain(target);
      expect(await readFile(target, "utf8")).toBe(edited);
      await writeFile(target, oldContent);
      expect(await isManagedFile(target, { ...pending, phase: undefined })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes an unchanged owned manifest during cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cleanup-manifest-"));
    try {
      const manifestPath = join(root, ".codex", "skills.json");
      await mkdir(join(root, ".codex"), { recursive: true });
      const manifest = {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "original", updatedAt: "2026-01-01",
        managedFiles: [manifestPath], skills: [],
      };
      await writeFile(manifestPath, JSON.stringify(manifest));
      const adapter = new CodexAdapter();
      // Cleanup of an unchanged manifest remains supported.
      const result = await adapter.cleanup({ task: "cleanup", root, skills: [] });
      expect(result.filesRemoved).toContain(manifestPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a dangling symlink at a managed destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-dangling-link-"));
    try {
      const { symlink } = await import("node:fs/promises");
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const dir = join(root, ".codex", "skills", "sample");
      await mkdir(dir, { recursive: true });
      const destination = join(dir, "SKILL.md");
      await symlink(join(root, "missing-target.md"), destination);
      const context = { task: "symlink", root, skills: [{
        path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] },
      }] };
      await expect(new CodexAdapter().apply(context)).rejects.toThrow();
      const { lstat } = await import("node:fs/promises");
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects dangling symlinks as existing directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-file-exists-link-"));
    try {
      const { symlink } = await import("node:fs/promises");
      const { fileExists } = await import("./filesystem-lifecycle.js");
      const dangling = join(root, "dangling.md");
      await symlink(join(root, "missing.md"), dangling);
      expect(await fileExists(dangling)).toBe(true);
      expect(await fileExists(join(root, "absent.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves user-edited managed files during forced cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-force-cleanup-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Original");
      const context = { task: "force-cleanup", root, skills: [{
        path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] },
      }] };
      const adapter = new CodexAdapter();
      await adapter.apply(context);
      const destination = join(root, ".codex", "skills", "sample", "SKILL.md");
      const edited = OWNERSHIP_HEADER + "# User edited";
      await writeFile(destination, edited);
      const result = await adapter.cleanup(context, { force: true });
      expect(result.filesRemoved).not.toContain(destination);
      expect(await readFile(destination, "utf8")).toBe(edited);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed digest metadata rather than treating it as a legacy manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-malformed-digest-"));
    try {
      const path = join(root, "skills.json");
      const base = {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "test", updatedAt: "2026-01-01", managedFiles: [path], skills: [],
      };
      for (const fileDigests of [null, [], { [path]: "not-a-digest" }]) {
        await writeFile(path, JSON.stringify({ ...base, fileDigests }));
        expect(await readPreviousManifest(path, "codex")).toBeNull();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never removes outside paths listed in legacy ownership manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-invalid-ownership-"));
    try {
      const agentRoot = join(root, ".codex");
      await mkdir(agentRoot, { recursive: true });
      const manifestPath = join(agentRoot, "skills.json");
      const outside = join(root, "user-owned.md");
      const content = OWNERSHIP_HEADER + "# User file";
      await writeFile(outside, content);
      const manifest = {
        managedBy: "skillgate", version: "1.0", agent: "codex",
        task: "invalid", updatedAt: "2026-01-01",
        managedFiles: [outside, manifestPath],
        fileDigests: { [outside]: createHash("sha256").update(content).digest("hex") },
        skills: [],
      };
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect(await readPreviousManifest(manifestPath, "codex")).not.toBeNull();

      const adapter = new CodexAdapter();
      const context = { task: "invalid", root, skills: [] };
      expect((await adapter.plan(context)).removals).not.toContain(outside);
      await adapter.apply(context);
      expect((await adapter.cleanup(context)).filesRemoved).not.toContain(outside);
      expect(await readFile(outside, "utf8")).toBe(content);
      await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains user-edited stale files during reconciliation and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-stale-edited-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Original");
      const adapter = new CodexAdapter();
      const skill = { path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] } };
      const initial = { task: "stale", root, skills: [skill] };
      await adapter.apply(initial);
      const target = join(root, ".codex", "skills", "sample", "SKILL.md");
      const edited = OWNERSHIP_HEADER + "# User edit";
      await writeFile(target, edited);

      const empty = { task: "stale", root, skills: [] };
      expect((await adapter.plan(empty)).removals).not.toContain(target);
      const result = await adapter.apply(empty);
      expect(result.filesRemoved).not.toContain(target);
      expect(await readFile(target, "utf8")).toBe(edited);
      const manifest = await readPreviousManifest(join(root, ".codex", "skills.json"), "codex");
      expect(manifest?.managedFiles).toContain(target);

      const cleanup = await adapter.cleanup(empty);
      expect(cleanup.filesRemoved).not.toContain(target);
      expect(await readFile(target, "utf8")).toBe(edited);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate skill destinations before creating ownership state", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-duplicate-destination-"));
    try {
      const first = join(root, "first.md");
      const second = join(root, "second.md");
      await writeFile(first, "# First");
      await writeFile(second, "# Second");
      const makeSkill = (path: string) => ({
        path, score: 1, reasons: [],
        metadata: { name: "same-name", description: "Duplicate", capabilities: [] },
      });
      const context = { task: "duplicate", root, skills: [makeSkill(first), makeSkill(second)] };
      await expect(new CodexAdapter().apply(context)).rejects.toThrow(/Skill name collision/);
      await expect(readFile(join(root, ".codex", "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, ".codex", "skills", "same-name", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans deterministically without writing managed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-plan-readonly-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Planned");
      const context = { task: "plan-only", root, skills: [{ path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      const adapter = new CodexAdapter();
      const first = await adapter.plan(context);
      expect(await adapter.plan(context)).toEqual(first);
      expect(first.conflicts).toEqual([]);
      await expect(readFile(join(root, ".codex", "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, ".codex", "skills", "sample", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps manifest bytes stable across identical applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-idempotent-manifest-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Stable");
      const context = { task: "stable", root, skills: [{ path: source, score: 1, reasons: [],
        metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      const adapter = new CodexAdapter();
      await adapter.apply(context);
      const manifestPath = join(root, ".codex", "skills.json");
      const first = await readFile(manifestPath, "utf8");
      await adapter.apply(context);
      expect(await readFile(manifestPath, "utf8")).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked managed directory without changing its external target", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-dir-link-"));
    const outside = await mkdtemp(join(tmpdir(), "skillgate-dir-link-outside-"));
    try {
      const { symlink } = await import("node:fs/promises");
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const externalFile = join(outside, "SKILL.md");
      await writeFile(externalFile, "# External user file");
      await mkdir(join(root, ".codex", "skills"), { recursive: true });
      await symlink(outside, join(root, ".codex", "skills", "sample"), "dir");
      const context = { task: "symlink-dir", root, skills: [{ path: source, score: 1,
        reasons: [], metadata: { name: "sample", description: "sample", capabilities: [] } }] };
      const adapter = new CodexAdapter();
      await expect(adapter.plan(context)).rejects.toThrow();
      await expect(adapter.apply(context)).rejects.toThrow();
      expect(await readFile(externalFile, "utf8")).toBe("# External user file");
      await expect(readFile(join(root, ".codex", "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cleans up Unicode skill directories generated by the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-unicode-cleanup-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Managed");
      const context = { task: "unicode", root, skills: [{
        path: source, score: 1, reasons: [],
        metadata: { name: "Café", description: "unicode", capabilities: [] },
      }] };
      const adapter = new CodexAdapter();
      const target = join(root, ".codex", "skills", "café", "SKILL.md");
      await adapter.apply(context);
      expect(await readFile(target, "utf8")).toBe(OWNERSHIP_HEADER + "# Managed");
      expect((await adapter.cleanup(context)).filesRemoved).toContain(target);
      await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles and cleans up Claude Code skills without touching source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-lifecycle-"));
    try {
      const firstSource = join(root, "first.md");
      const secondSource = join(root, "second.md");
      await writeFile(firstSource, "# First");
      await writeFile(secondSource, "# Second");
      const makeSkill = (path: string, name: string) => ({
        path, score: 1, reasons: [],
        metadata: { name, description: name, capabilities: [] },
      });
      const first = makeSkill(firstSource, "first");
      const second = makeSkill(secondSource, "second");
      const initial = { task: "claude-lifecycle", root, skills: [first, second] };
      const adapter = new ClaudeCodeAdapter();
      const manifestPath = join(root, ".claude", "skills.json");
      const firstTarget = join(root, ".claude", "skills", "first", "SKILL.md");
      const secondTarget = join(root, ".claude", "skills", "second", "SKILL.md");

      const plan = await adapter.plan(initial);
      expect(await adapter.plan(initial)).toEqual(plan);
      expect(plan.writes).toEqual([firstTarget, secondTarget, manifestPath]);
      await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await adapter.apply(initial);
      expect(await readFile(firstTarget, "utf8")).toBe(OWNERSHIP_HEADER + "# First");
      expect(await readFile(secondTarget, "utf8")).toBe(OWNERSHIP_HEADER + "# Second");
      const originalManifest = await readFile(manifestPath, "utf8");
      await adapter.apply(initial);
      expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);

      const reduced = { ...initial, skills: [first] };
      expect((await adapter.plan(reduced)).removals).toContain(secondTarget);
      const reconciled = await adapter.apply(reduced);
      expect(reconciled.filesRemoved).toContain(secondTarget);
      await expect(readFile(secondTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(firstTarget, "utf8")).toBe(OWNERSHIP_HEADER + "# First");

      const cleaned = await adapter.cleanup(reduced);
      expect(cleaned.filesRemoved).toContain(firstTarget);
      expect(cleaned.filesRemoved).toContain(manifestPath);
      await expect(readFile(firstTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(firstSource, "utf8")).toBe("# First");
      expect(await readFile(secondSource, "utf8")).toBe("# Second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
