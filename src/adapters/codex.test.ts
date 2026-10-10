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
      await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
