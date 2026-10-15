import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude.js";

describe("ClaudeCodeAdapter", () => {
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

  it("preflights source reads before changing existing Claude state", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-preflight-"));
    try {
      const adapter = new ClaudeCodeAdapter();
      const source = join(root, "source.md");
      await writeFile(source, "# Initial");
      const select = (path: string, name: string) => ({
        path, metadata: { name, description: name }, score: 1, reasons: [],
      });
      await adapter.apply({ task: "initial", root, skills: [select(source, "first")] });
      const target = join(root, ".claude", "skills", "first", "SKILL.md");
      const manifest = join(root, ".claude", "skills.json");
      const oldTarget = await readFile(target, "utf8");
      const oldManifest = await readFile(manifest, "utf8");
      await writeFile(source, "# Changed");
      await expect(adapter.apply({
        task: "next", root, skills: [select(source, "first"), select(root, "second")],
      })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe(oldTarget);
      expect(await readFile(manifest, "utf8")).toBe(oldManifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it("keeps the Claude ownership manifest unchanged on equivalent reapply", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-idempotent-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Instructions");
      const adapter = new ClaudeCodeAdapter();
      const context = { task: "repeat", root, skills: [{
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      }] };
      const plan = await adapter.plan(context);
      expect(plan.writes).toContain(join(root, ".claude", "skills", "example", "SKILL.md"));
      const first = await adapter.apply(context);
      expect(first.filesWritten).toEqual(plan.writes);
      const manifestPath = join(root, ".claude", "skills.json");
      const original = await readFile(manifestPath, "utf8");
      await adapter.apply(context);
      expect(await readFile(manifestPath, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up stale Claude-managed skills without deleting unrelated user files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-cleanup-"));
    try {
      const source = join(root, "source.md");
      const userFile = join(root, "keep.md");
      await writeFile(source, "# Managed");
      await writeFile(userFile, "# User");
      const adapter = new ClaudeCodeAdapter();
      const selected = { path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [] };
      await adapter.apply({ task: "first", root, skills: [selected] });
      const target = join(root, ".claude", "skills", "example", "SKILL.md");
      const empty = { task: "second", root, skills: [] };
      const plan = await adapter.plan(empty);
      expect(plan.removals).toContain(target);
      const result = await adapter.apply(empty);
      expect(result.filesRemoved).toContain(target);
      await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(userFile, "utf8")).toBe("# User");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a user-owned Claude skill without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-conflict-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const adapter = new ClaudeCodeAdapter();
      const selected = { path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [] };
      const context = { task: "test", root, skills: [selected] };
      await adapter.apply(context);
      const target = join(root, ".claude", "skills", "example", "SKILL.md");
      await writeFile(target, "# User replacement");
      const plan = await adapter.plan(context);
      expect(plan.conflicts).toContain(target);
      await expect(adapter.apply(context)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("# User replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  it("planning is deterministic and does not write Claude files", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-claude-plan-only-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const adapter = new ClaudeCodeAdapter();
      const context = { task: "plan only", root, skills: [{
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      }] };
      const first = await adapter.plan(context);
      expect(await adapter.plan(context)).toEqual(first);
      expect(first.writes).toContain(join(root, ".claude", "skills", "example", "SKILL.md"));
      await expect(readFile(join(root, ".claude", "skills.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
