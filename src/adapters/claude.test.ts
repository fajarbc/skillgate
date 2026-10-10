import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude.js";

describe("ClaudeCodeAdapter", () => {
  it("plans without modifying the workspace and detects existing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-plan-"));
    try {
      const adapter = new ClaudeCodeAdapter();
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
      const first = await adapter.plan(context);
      expect(first?.filesToWrite).toHaveLength(2);
      expect(first?.conflicts).toEqual([]);
      const second = await adapter.plan(context);
      expect(second).toEqual(first);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(root)).toEqual([]);
      await adapter.apply(context);
      const afterApply = await adapter.plan(context);
      expect(afterApply?.conflicts).toEqual([]);
      await adapter.apply(context);
      const target = afterApply?.filesToWrite.find((file) => file.endsWith("SKILL.md"));
      expect(target).toBeDefined();
      await writeFile(target!, "user-modified content");
      expect((await adapter.plan(context))?.conflicts).toContain(target);
      await expect(adapter.apply(context)).rejects.toThrow("Refusing to overwrite existing adapter files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked managed skills directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "skillgate-external-"));
    try {
      const { mkdir, symlink } = await import("node:fs/promises");
      await mkdir(join(root, ".claude"));
      await symlink(external, join(root, ".claude", "skills"), "dir");
      const adapter = new ClaudeCodeAdapter();
      await expect(adapter.plan({
        task: "test",
        root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      })).rejects.toThrow("Unsafe managed parent");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("cleans up only unchanged managed files and preserves user edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-cleanup-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const target = join(root, ".claude", "skills", "example", "SKILL.md");
      const original = await readFile(target, "utf8");
      await writeFile(target, "user edit");
      await expect(adapter.cleanup(context)).rejects.toThrow("Refusing to remove modified managed files");
      expect(await readFile(target, "utf8")).toBe("user edit");
      await writeFile(target, original);
      await expect(adapter.cleanup(context)).resolves.toMatchObject({ filesWritten: [] });
      await expect(adapter.cleanup(context)).resolves.toMatchObject({ filesWritten: [] });
      await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans and removes stale managed skills without deleting unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-stale-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const makeSkill = (name: string) => ({
        path: join(root, name + ".md"),
        metadata: { name, description: "Example" },
        score: 1,
        reasons: [],
      });
      const initial = { task: "test", root, skills: [makeSkill("first"), makeSkill("second")] };
      await adapter.apply(initial);
      const unrelated = join(root, ".claude", "skills", "first", "notes.txt");
      await writeFile(unrelated, "user-owned");
      const reduced = { ...initial, skills: [makeSkill("first")] };
      const stale = join(root, ".claude", "skills", "second", "SKILL.md");
      const preview = await adapter.plan(reduced);
      expect(preview.filesToRemove).toEqual([stale]);
      expect(preview.conflicts).toEqual([]);
      expect(await readFile(stale, "utf8")).toContain("second");
      await adapter.apply(reduced);
      await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(unrelated, "utf8")).toBe("user-owned");
      expect((await adapter.plan(reduced)).filesToRemove).toEqual([]);
      await adapter.cleanup(reduced);
      expect(await readFile(unrelated, "utf8")).toBe("user-owned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses stale cleanup when a removed skill was modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-stale-conflict-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const skill = (name: string) => ({
        path: join(root, name + ".md"),
        metadata: { name, description: "Example" },
        score: 1,
        reasons: [],
      });
      const context = { task: "test", root, skills: [skill("first"), skill("second")] };
      await adapter.apply(context);
      const modified = join(root, ".claude", "skills", "second", "SKILL.md");
      await writeFile(modified, "user modification");
      const reduced = { ...context, skills: [skill("first")] };
      expect((await adapter.plan(reduced)).conflicts).toContain(modified);
      await expect(adapter.apply(reduced)).rejects.toThrow("Refusing to overwrite existing adapter files");
      expect(await readFile(modified, "utf8")).toBe("user modification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers cleanup after an owned file was already removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-recovery-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const missing = join(root, ".claude", "skills", "example", "SKILL.md");
      await rm(missing);
      expect((await adapter.plan(context)).conflicts).toEqual([]);
      await adapter.apply(context);
      expect(await readFile(missing, "utf8")).toContain("example");
      await rm(missing);
      await expect(adapter.cleanup(context)).resolves.toMatchObject({ filesWritten: [] });
      await expect(readFile(join(root, ".claude", "skillgate-owned.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses unmanaged targets without leaving staged temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-unmanaged-"));
    try {
      const { mkdir, readdir } = await import("node:fs/promises");
      const skillsDir = join(root, ".claude", "skills", "example");
      await mkdir(skillsDir, { recursive: true });
      const target = join(skillsDir, "SKILL.md");
      await writeFile(target, "user content");
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await expect(adapter.apply(context)).rejects.toThrow("Refusing to overwrite existing adapter files");
      expect(await readFile(target, "utf8")).toBe("user content");
      expect(await readdir(skillsDir)).toEqual(["SKILL.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a published output from an interrupted journaled apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-journal-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { prepareManagedTargets } = await import("./ownership.js");
      const agentDir = join(root, ".claude");
      const skillDir = join(agentDir, "skills", "example");
      await mkdir(skillDir, { recursive: true });
      const target = join(skillDir, "SKILL.md");
      const content = "---\\nname: example\\ndescription: Example\\n---\\n".replaceAll("\\n", "\n");
      await prepareManagedTargets(agentDir, [{ path: target, content }]);
      await writeFile(target, content);
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      expect((await adapter.plan(context)).conflicts).toEqual([]);
      await adapter.apply(context);
      await expect(adapter.cleanup(context)).resolves.toMatchObject({ filesWritten: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted ownership manifests before modifying managed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-corrupt-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const target = join(root, ".claude", "skills", "example", "SKILL.md");
      const before = await readFile(target, "utf8");
      const manifest = join(root, ".claude", "skillgate-owned.json");
      await writeFile(manifest, '{"version":1,"files":{"../../outside":"aaaaaaaa"}}');
      await expect(adapter.plan(context)).rejects.toThrow("invalid ownership entries");
      await expect(adapter.apply(context)).rejects.toThrow("invalid ownership entries");
      expect(await readFile(target, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overlapping operations and releases the lock after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lock-"));
    try {
      const { mkdir, readdir } = await import("node:fs/promises");
      const { withManagedLock } = await import("./ownership.js");
      const agentDir = join(root, ".claude");
      await mkdir(agentDir);
      const adapter = new ClaudeCodeAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await withManagedLock(agentDir, async () => {
        await expect(adapter.apply(context)).rejects.toThrow("Adapter directory is locked");
        await expect(adapter.cleanup(context)).rejects.toThrow("Adapter directory is locked");
      });
      await expect(withManagedLock(agentDir, async () => {
        throw new Error("simulated failure");
      })).rejects.toThrow("simulated failure");
      expect(await readdir(agentDir)).toEqual([]);
      await adapter.apply(context);
      await adapter.cleanup(context);
      expect((await readdir(agentDir)).includes(".skillgate.lock")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never removes a pre-existing adapter lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-existing-lock-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const agentDir = join(root, ".claude");
      await mkdir(agentDir);
      const lock = join(agentDir, ".skillgate.lock");
      await writeFile(lock, "held by another process");
      const adapter = new ClaudeCodeAdapter();
      const context = { task: "test", root, skills: [] };
      await expect(adapter.apply(context)).rejects.toThrow("Adapter directory is locked");
      await expect(adapter.cleanup(context)).rejects.toThrow("Adapter directory is locked");
      expect(await readFile(lock, "utf8")).toBe("held by another process");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats skills into Markdown instructions for Claude Code", async () => {
    const adapter = new ClaudeCodeAdapter();
    const formatted = await adapter.format({
      task: "build backend",
      root: "/tmp",
      skills: [
        {
          path: "/path/to/SKILL.md",
          metadata: {
            name: "node-api",
            description: "Node.js REST API",
            capabilities: ["network"],
          },
          score: 12,
          reasons: [],
        },
      ],
    });

    expect(formatted).toContain("# Skills for Claude Code");
    expect(formatted).toContain("node-api");
    expect(formatted).toContain("Node.js REST API");
    expect(formatted).toContain("Capabilities: network");
  });

  it("applies skills by writing to .claude directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(
      skillPath,
      "---\nname: my-skill\ndescription: A test skill\n---\n# Instructions\nExecute tests.",
    );

    const adapter = new ClaudeCodeAdapter();
    const result = await adapter.apply({
      task: "run tests",
      root,
      skills: [
        {
          path: skillPath,
          metadata: { name: "my-skill", description: "A test skill" },
          score: 7,
          reasons: [],
        },
      ],
    });

    expect(result.agent).toBe("claude-code");
    expect(result.exposedSkills).toEqual(["my-skill"]);
    expect(result.filesWritten.length).toBe(2);

    const writtenSkill = await readFile(
      join(root, ".claude", "skills", "my-skill", "SKILL.md"),
      "utf8",
    );
    expect(writtenSkill).toContain("Execute tests.");

    const manifest = JSON.parse(await readFile(join(root, ".claude", "skills.json"), "utf8"));
    expect(manifest.skills[0].name).toBe("my-skill");

    await rm(root, { recursive: true, force: true });
  });
});
