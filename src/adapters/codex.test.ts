import { legacyCooperativeAdapter } from "./testing/adapter-contract.test.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { CodexAdapter } from "./codex.js";

async function createTestSymlink(context: TestContext, target: string, path: string, type: "dir" | "file") {
  try {
    await symlink(target, path, type);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "ENOSYS")) {
      context.skip(`Symlink creation unavailable on this Windows account (${code})`);
    }
    throw error;
  }
}

describe("CodexAdapter", () => {
  it("formats skills into Markdown instructions", async () => {
    const adapter = legacyCooperativeAdapter(new CodexAdapter());
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

  it("refuses symlinked adapter directories before planning or writing", async (test) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-symlink-"));
    try {
      const outside = join(root, "outside");
      await mkdir(outside);
      await createTestSymlink(test, outside, join(root, ".codex"), "dir");
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const context = { task: "test", root, skills: [] };
      await expect(adapter.plan(context)).rejects.toThrow(/Unsafe symlinked adapter path/);
      await expect(adapter.apply(context)).rejects.toThrow(/Unsafe symlinked adapter path/);
      await expect(readFile(join(outside, "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked skill destination files without touching their targets", async (test) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-file-link-"));
    try {
      const outside = join(root, "outside.md");
      const source = join(root, "source.md");
      await writeFile(outside, "# Protected");
      await writeFile(source, "# Source");
      const destDir = join(root, ".codex", "skills", "example");
      await mkdir(destDir, { recursive: true });
      await createTestSymlink(test, outside, join(destDir, "SKILL.md"), "file");
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const context = { task: "test", root, skills: [{
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      }] };
      await expect(adapter.plan(context)).rejects.toThrow(/Unsafe symlinked adapter path/);
      await expect(adapter.apply(context, { force: true })).rejects.toThrow(/Unsafe symlinked adapter path/);
      expect(await readFile(outside, "utf8")).toBe("# Protected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked manifest files even with force", async (test) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-manifest-link-"));
    try {
      const outside = join(root, "outside.json");
      await writeFile(outside, "protected");
      await mkdir(join(root, ".codex"));
      await createTestSymlink(test, outside, join(root, ".codex", "skills.json"), "file");
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      await expect(adapter.apply({ task: "test", root, skills: [] }, { force: true }))
        .rejects.toThrow(/Unsafe symlinked adapter path/);
      expect(await readFile(outside, "utf8")).toBe("protected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not delete arbitrary paths from a forged ownership manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-forged-"));
    try {
      const adapterRoot = join(root, ".codex");
      await mkdir(adapterRoot);
      const protectedPath = join(root, "keep.txt");
      await writeFile(protectedPath, "keep this content");
      await writeFile(join(adapterRoot, "skills.json"), JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex", task: "test",
        updatedAt: "", managedFiles: [protectedPath], skills: [],
      }));
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const result = await adapter.cleanup({ task: "test", root, skills: [] });
      expect(result.filesRemoved).not.toContain(protectedPath);
      expect(await readFile(protectedPath, "utf8")).toBe("keep this content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a forged ownership marker embedded in user content", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-marker-"));
    try {
      const adapterRoot = join(root, ".codex");
      const targetDir = join(adapterRoot, "skills", "example");
      await mkdir(targetDir, { recursive: true });
      const target = join(targetDir, "SKILL.md");
      const original = "# User content\\n<!-- Managed by SkillGate. Do not edit directly. -->";
      await writeFile(target, original);
      await writeFile(join(adapterRoot, "skills.json"), JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex", task: "test",
        updatedAt: "", managedFiles: [target, join(adapterRoot, "skills.json")], skills: [],
      }));
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      await adapter.cleanup({ task: "test", root, skills: [] });
      expect(await readFile(target, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a user-edited stale skill when reapplying an empty selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-stale-"));
    try {
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const source = join(root, "source.md");
      await writeFile(source, "# Managed source");
      const skill = {
        path: source,
        metadata: { name: "example", description: "Example" },
        score: 1,
        reasons: [],
      };
      await adapter.apply({ task: "initial", root, skills: [skill] });
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      await writeFile(target, "# User edited content");
      const next = { task: "empty", root, skills: [] };
      const plan = await adapter.plan(next);
      expect(plan.removals).not.toContain(target);
      await adapter.apply(next);
      expect(await readFile(target, "utf8")).toBe("# User edited content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects user-replaced skill files even when the manifest lists them", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-replaced-"));
    try {
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const selected = {
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      };
      const context = { task: "test", root, skills: [selected] };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      await writeFile(target, "# User replacement");
      const plan = await adapter.plan(context);
      expect(plan.conflicts).toContain(target);
      await expect(adapter.apply(context)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("# User replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed manifest path entries without deleting user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-invalid-manifest-"));
    try {
      const agentRoot = join(root, ".codex");
      await mkdir(agentRoot);
      const manifestPath = join(agentRoot, "skills.json");
      const protectedFile = join(root, "keep.txt");
      await writeFile(protectedFile, "preserve me");
      await writeFile(manifestPath, JSON.stringify({
        managedBy: "skillgate", version: "1.0", agent: "codex", task: "test",
        updatedAt: "", managedFiles: [null, { path: protectedFile }, protectedFile],
        skills: [],
      }));
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const context = { task: "test", root, skills: [] };
      const plan = await adapter.plan(context);
      expect(plan.conflicts).toContain(manifestPath);
      await expect(adapter.apply(context)).rejects.toThrow();
      const cleanup = await adapter.cleanup(context);
      expect(cleanup.filesRemoved).toEqual([]);
      expect(await readFile(protectedFile, "utf8")).toBe("preserve me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains ownership records for user-edited stale files after reapply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-retain-"));
    try {
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const selected = {
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      };
      await adapter.apply({ task: "first", root, skills: [selected] });
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      await writeFile(target, "# User changed this file");
      await adapter.apply({ task: "second", root, skills: [] });
      const manifest = JSON.parse(await readFile(join(root, ".codex", "skills.json"), "utf8"));
      expect(manifest.managedFiles).toContain(target);
      const cleanup = await adapter.cleanup({ task: "cleanup", root, skills: [] });
      expect(cleanup.filesRemoved).not.toContain(target);
      expect(await readFile(target, "utf8")).toBe("# User changed this file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains manifest on cleanup while a user-edited tracked skill remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-cleanup-recovery-"));
    try {
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const selected = {
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      };
      const context = { task: "test", root, skills: [selected] };
      await adapter.apply(context);
      const target = join(root, ".codex", "skills", "example", "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      await writeFile(target, "# User-owned modification");
      const cleanup = await adapter.cleanup(context);
      expect(cleanup.filesRemoved).not.toContain(target);
      expect(cleanup.filesRemoved).not.toContain(manifestPath);
      expect(JSON.parse(await readFile(manifestPath, "utf8")).managedFiles).toContain(target);
      expect(await readFile(target, "utf8")).toBe("# User-owned modification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it("preflights later source read failures without mutating earlier destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-preflight-"));
    try {
      const valid = join(root, "valid.md");
      await writeFile(valid, "# Valid source");
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const skills = [
        { path: valid, metadata: { name: "first", description: "First" }, score: 1, reasons: [] },
        { path: root, metadata: { name: "second", description: "Second" }, score: 1, reasons: [] },
      ];
      await expect(adapter.apply({ task: "preflight", root, skills })).rejects.toThrow();
      await expect(readFile(join(root, ".codex", "skills", "first", "SKILL.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, ".codex", "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a recovery manifest after an interrupted multi-skill apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-partial-"));
    try {
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const blocked = join(root, ".codex", "skills", "second", "SKILL.md");
      await mkdir(blocked, { recursive: true });
      const select = (name: string) => ({
        path: source, metadata: { name, description: name }, score: 1, reasons: [],
      });
      const context = {
        task: "partial", root, skills: [select("first"), select("second")],
      };
      await expect(adapter.apply(context, { force: true })).rejects.toThrow();
      const first = join(root, ".codex", "skills", "first", "SKILL.md");
      const manifestPath = join(root, ".codex", "skills.json");
      expect(await readFile(first, "utf8")).toContain("# Source");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.managedFiles).toContain(first);
      expect(manifest.managedFiles).toContain(blocked);
      await adapter.cleanup(context);
      await expect(readFile(first, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(manifestPath, "utf8")).toContain("managedFiles");
      await rm(blocked, { recursive: true });
      await adapter.cleanup(context);
      await expect(readFile(manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it("keeps ownership manifest stable across identical applies", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-idempotent-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const adapter = legacyCooperativeAdapter(new CodexAdapter());
      const context = { task: "repeat", root, skills: [{
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      }] };
      await adapter.apply(context);
      const manifestPath = join(root, ".codex", "skills.json");
      const first = await readFile(manifestPath, "utf8");
      await adapter.apply(context);
      expect(await readFile(manifestPath, "utf8")).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies skills by writing to .codex directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-codex-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(
      skillPath,
      "---\nname: my-skill\ndescription: A test skill\n---\n# Instructions\nRun this.",
    );

    const adapter = legacyCooperativeAdapter(new CodexAdapter());
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
