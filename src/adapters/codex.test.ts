import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex.js";

describe("CodexAdapter", () => {
  it("plans without modifying the workspace and detects existing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-plan-"));
    try {
      const adapter = new CodexAdapter();
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
      await mkdir(join(root, ".codex"));
      await symlink(external, join(root, ".codex", "skills"), "dir");
      const adapter = new CodexAdapter();
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
      const adapter = new CodexAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
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
      const adapter = new CodexAdapter();
      const makeSkill = (name: string) => ({
        path: join(root, name + ".md"),
        metadata: { name, description: "Example" },
        score: 1,
        reasons: [],
      });
      const initial = { task: "test", root, skills: [makeSkill("first"), makeSkill("second")] };
      await adapter.apply(initial);
      const unrelated = join(root, ".codex", "skills", "first", "notes.txt");
      await writeFile(unrelated, "user-owned");
      const reduced = { ...initial, skills: [makeSkill("first")] };
      const stale = join(root, ".codex", "skills", "second", "SKILL.md");
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
      const adapter = new CodexAdapter();
      const skill = (name: string) => ({
        path: join(root, name + ".md"),
        metadata: { name, description: "Example" },
        score: 1,
        reasons: [],
      });
      const context = { task: "test", root, skills: [skill("first"), skill("second")] };
      await adapter.apply(context);
      const modified = join(root, ".codex", "skills", "second", "SKILL.md");
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
      const adapter = new CodexAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const missing = join(root, ".codex", "skills", "example", "SKILL.md");
      await rm(missing);
      expect((await adapter.plan(context)).conflicts).toEqual([]);
      await adapter.apply(context);
      expect(await readFile(missing, "utf8")).toContain("example");
      await rm(missing);
      await expect(adapter.cleanup(context)).resolves.toMatchObject({ filesWritten: [] });
      await expect(readFile(join(root, ".codex", "skillgate-owned.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses unmanaged targets without leaving staged temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-unmanaged-"));
    try {
      const { mkdir, readdir } = await import("node:fs/promises");
      const skillsDir = join(root, ".codex", "skills", "example");
      await mkdir(skillsDir, { recursive: true });
      const target = join(skillsDir, "SKILL.md");
      await writeFile(target, "user content");
      const adapter = new CodexAdapter();
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
      const agentDir = join(root, ".codex");
      const skillDir = join(agentDir, "skills", "example");
      await mkdir(skillDir, { recursive: true });
      const target = join(skillDir, "SKILL.md");
      const content = "---\\nname: example\\ndescription: Example\\n---\\n".replaceAll("\\n", "\n");
      await prepareManagedTargets(agentDir, [{ path: target, content }]);
      await writeFile(target, content);
      const adapter = new CodexAdapter();
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

  it("rejects changing the intended set while a replacement remains pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-pending-set-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { prepareManagedTargets } = await import("./ownership.js");
      const agentDir = join(root, ".codex");
      const skillDir = join(agentDir, "skills", "example");
      await mkdir(skillDir, { recursive: true });
      const target = join(skillDir, "SKILL.md");
      const original = "original";
      const replacement = "replacement";
      await prepareManagedTargets(agentDir, [{ path: target, content: original }]);
      await writeFile(target, original);
      const { recordManagedTargets } = await import("./ownership.js");
      await recordManagedTargets(agentDir, [target], [{ path: target, content: original }]);
      await prepareManagedTargets(agentDir, [{ path: target, content: replacement }]);
      await expect(prepareManagedTargets(agentDir, [])).rejects.toThrow("Pending replacement requires recovery");
      expect(await readFile(target, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects user edits with a trailing separator in the adapter root", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-root-path-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { checkManagedTargets, prepareManagedTargets, recordManagedTargets } = await import("./ownership.js");
      const agentDir = join(root, ".codex");
      const target = join(agentDir, "skills", "example", "SKILL.md");
      await mkdir(join(agentDir, "skills", "example"), { recursive: true });
      await prepareManagedTargets(agentDir, [{ path: target, content: "managed" }]);
      await writeFile(target, "managed");
      await recordManagedTargets(agentDir, [target], [{ path: target, content: "managed" }]);
      expect(await checkManagedTargets(agentDir + "/", [target])).toEqual([]);
      await writeFile(target, "user edit");
      expect(await checkManagedTargets(agentDir + "/", [target])).toEqual([target]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a replacement published before its ownership commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-replace-crash-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { checkManagedTargets, prepareManagedTargets, recordManagedTargets, writeManagedTarget } = await import("./ownership.js");
      const agentDir = join(root, ".codex");
      const target = join(agentDir, "skills", "example", "SKILL.md");
      await mkdir(join(agentDir, "skills", "example"), { recursive: true });
      await prepareManagedTargets(agentDir, [{ path: target, content: "old" }]);
      await writeManagedTarget(agentDir, target, "old");
      await recordManagedTargets(agentDir, [target], [{ path: target, content: "old" }]);
      await prepareManagedTargets(agentDir, [{ path: target, content: "new" }]);
      await writeManagedTarget(agentDir, target, "new");
      // Simulate a crash before recordManagedTargets: the journal must authorize recovery.
      expect(await checkManagedTargets(agentDir, [target])).toEqual([]);
      await prepareManagedTargets(agentDir, [{ path: target, content: "new" }]);
      await recordManagedTargets(agentDir, [target], [{ path: target, content: "new" }]);
      expect(await checkManagedTargets(agentDir, [target])).toEqual([]);
      await expect(readFile(join(agentDir, "skillgate-replacements.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(target, "user-modified");
      expect(await checkManagedTargets(agentDir, [target])).toEqual([target]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a dead-process lock but never steals a live lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-dead-lock-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { withManagedLock } = await import("./ownership.js");
      const agentDir = join(root, ".codex");
      await mkdir(agentDir);
      const lockPath = join(agentDir, ".skillgate.lock");
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await expect(withManagedLock(agentDir, async () => "unsafe")).rejects.toThrow("locked");
      // A very large positive PID is not guaranteed to be absent on every platform;
      // use a platform-supported ESRCH probe before asserting recovery.
      const deadPid = 2147483647;
      let absent = false;
      try { process.kill(deadPid, 0); } catch (error) {
        absent = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (absent) {
        await writeFile(lockPath, JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }));
        await expect(withManagedLock(agentDir, async () => "recovered")).resolves.toBe("recovered");
        await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted ownership manifests before modifying managed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-corrupt-"));
    try {
      const adapter = new CodexAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      const before = await readFile(target, "utf8");
      const manifest = join(root, ".codex", "skillgate-owned.json");
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
      const agentDir = join(root, ".codex");
      await mkdir(agentDir);
      const adapter = new CodexAdapter();
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
      const agentDir = join(root, ".codex");
      await mkdir(agentDir);
      const lock = join(agentDir, ".skillgate.lock");
      await writeFile(lock, "held by another process");
      const adapter = new CodexAdapter();
      const context = { task: "test", root, skills: [] };
      await expect(adapter.apply(context)).rejects.toThrow("Adapter directory is locked");
      await expect(adapter.cleanup(context)).rejects.toThrow("Adapter directory is locked");
      expect(await readFile(lock, "utf8")).toBe("held by another process");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to record unexpected modified output as owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-ownership-commit-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const { prepareManagedTargets, recordManagedTargets } = await import("./ownership.js");
      const agentDir = join(root, ".codex");
      const skillDir = join(agentDir, "skills", "example");
      await mkdir(skillDir, { recursive: true });
      const target = join(skillDir, "SKILL.md");
      const expected = [{ path: target, content: "intended content" }];
      await prepareManagedTargets(agentDir, expected);
      await writeFile(target, "unexpected modification");
      await expect(recordManagedTargets(agentDir, [target], expected))
        .rejects.toThrow("Managed output changed before ownership commit");
      expect(await readFile(target, "utf8")).toBe("unexpected modification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked adapter root for both apply and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-root-link-"));
    const external = await mkdtemp(join(tmpdir(), "skillgate-root-external-"));
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(external, join(root, ".codex"), "dir");
      const adapter = new CodexAdapter();
      const context = {
        task: "test", root,
        skills: [{ path: join(root, "source.md"), metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await expect(adapter.apply(context)).rejects.toThrow("Unsafe adapter directory");
      await expect(adapter.cleanup(context)).rejects.toThrow("Unsafe adapter directory");
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(external)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects symlinked workspace ancestors before writing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "skillgate-workspace-link-"));
    try {
      const { mkdir, symlink, readdir } = await import("node:fs/promises");
      const real = join(parent, "real");
      await mkdir(real);
      const alias = join(parent, "alias");
      await symlink(real, alias, "dir");
      const adapter = new CodexAdapter();
      const context = { task: "test", root: alias, skills: [] };
      await expect(adapter.apply(context)).rejects.toThrow("Unsafe workspace ancestor");
      await expect(adapter.cleanup(context)).rejects.toThrow("Unsafe workspace ancestor");
      expect(await readdir(real)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("recovers a replacement interrupted after publishing a previously owned skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-replacement-"));
    try {
      const { prepareManagedTargets, writeManagedTarget } = await import("./ownership.js");
      const adapter = new CodexAdapter();
      const source = join(root, "source.md");
      await writeFile(source, "old skill content");
      const context = {
        task: "test", root,
        skills: [{ path: source, metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }],
      };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      await writeFile(source, "new skill content");
      const agentDir = join(root, ".codex");
      await prepareManagedTargets(agentDir, [{ path: target, content: "new skill content" }]);
      await writeManagedTarget(agentDir, target, "new skill content");
      expect((await adapter.plan(context)).conflicts).toEqual([]);
      await adapter.apply(context);
      expect(await readFile(target, "utf8")).toBe("new skill content");
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(agentDir)).includes("skillgate-replacements.json")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks cleanup while a replacement journal is unfinished", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-pending-cleanup-"));
    try {
      const { prepareManagedTargets } = await import("./ownership.js");
      const adapter = new CodexAdapter();
      const source = join(root, "source.md");
      await writeFile(source, "initial");
      const context = { task: "test", root, skills: [{ path: source, metadata: { name: "example", description: "Example" }, score: 1, reasons: [] }] };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      await prepareManagedTargets(join(root, ".codex"), [{ path: target, content: "replacement" }]);
      await expect(adapter.cleanup(context)).rejects.toThrow("replacement transaction is pending");
      expect(await readFile(target, "utf8")).toBe("initial");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats skills into Markdown instructions", async () => {
    const adapter = new CodexAdapter();
    const formatted = await adapter.format({
      task: "build feature",
      root: "/tmp",
      skills: [
        {
          path: "/path/to/SKILL.md",
          metadata: { name: "testing", description: "Run tests", capabilities: ["exec"] },
          score: 10,
          reasons: [],
        },
      ],
    });

    expect(formatted).toContain("# Skills for OpenAI Codex");
    expect(formatted).toContain("testing");
    expect(formatted).toContain("Run tests");
    expect(formatted).toContain("Capabilities: exec");
  });

  it("applies skills by writing to .codex directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(
      skillPath,
      "---\nname: my-skill\ndescription: A test skill\n---\n# Instructions\nRun this.",
    );

    const adapter = new CodexAdapter();
    const result = await adapter.apply({
      task: "run test",
      root,
      skills: [
        {
          path: skillPath,
          metadata: { name: "my-skill", description: "A test skill" },
          score: 5,
          reasons: [],
        },
      ],
    });

    expect(result.agent).toBe("codex");
    expect(result.exposedSkills).toEqual(["my-skill"]);
    expect(result.filesWritten.length).toBe(2);

    const writtenSkill = await readFile(
      join(root, ".codex", "skills", "my-skill", "SKILL.md"),
      "utf8",
    );
    expect(writtenSkill).toContain("Run this.");

    const manifest = JSON.parse(await readFile(join(root, ".codex", "skills.json"), "utf8"));
    expect(manifest.skills[0].name).toBe("my-skill");

    await rm(root, { recursive: true, force: true });
  });
});
