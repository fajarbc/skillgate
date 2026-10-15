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
