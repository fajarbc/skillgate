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
      expect(afterApply?.conflicts).toHaveLength(2);
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
