import { legacyCooperativeAdapter } from "./testing/adapter-contract.test.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdapterConflictError,
  ClaudeCodeAdapter,
  CodexAdapter,
} from "./index.js";

describe("adapter lifecycle", () => {
  it("computes dry-run plan matching subsequent apply writes and removals", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lifecycle-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(skillPath, "---\nname: my-skill\ndescription: Test skill\n---\n# Docs");

    const adapter = legacyCooperativeAdapter(new CodexAdapter());
    const context = {
      task: "build",
      root,
      skills: [
        {
          path: skillPath,
          metadata: { name: "my-skill", description: "Test skill" },
          score: 10,
          reasons: [],
        },
      ],
    };

    const plan = await adapter.plan(context);
    expect(plan.writes.length).toBe(2);
    expect(plan.removals.length).toBe(0);
    expect(plan.conflicts.length).toBe(0);

    const result = await adapter.apply(context);
    expect(result.filesWritten).toEqual(plan.writes);

    await rm(root, { recursive: true, force: true });
  });

  it("applies changes idempotently without conflicts on repeat runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lifecycle-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(skillPath, "---\nname: my-skill\ndescription: Test skill\n---\n# Docs");

    const adapter = legacyCooperativeAdapter(new ClaudeCodeAdapter());
    const context = {
      task: "build",
      root,
      skills: [
        {
          path: skillPath,
          metadata: { name: "my-skill", description: "Test skill" },
          score: 10,
          reasons: [],
        },
      ],
    };

    const firstResult = await adapter.apply(context);
    const secondResult = await adapter.apply(context);

    expect(secondResult.filesWritten).toEqual(firstResult.filesWritten);
    expect(secondResult.exposedSkills).toEqual(["my-skill"]);

    await rm(root, { recursive: true, force: true });
  });

  it("detects conflict and refuses to overwrite user-owned files without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lifecycle-"));
    const skillPath = join(root, "my-skill.md");
    await writeFile(skillPath, "---\nname: my-skill\ndescription: Test skill\n---\n# Docs");

    const destDir = join(root, ".codex", "skills", "my-skill");
    await mkdir(destDir, { recursive: true });
    const userOwnedFile = join(destDir, "SKILL.md");
    await writeFile(userOwnedFile, "User-owned original notes", "utf8");

    const adapter = legacyCooperativeAdapter(new CodexAdapter());
    const context = {
      task: "build",
      root,
      skills: [
        {
          path: skillPath,
          metadata: { name: "my-skill", description: "Test skill" },
          score: 10,
          reasons: [],
        },
      ],
    };

    const plan = await adapter.plan(context);
    expect(plan.conflicts).toContain(userOwnedFile);

    await expect(adapter.apply(context)).rejects.toThrow(AdapterConflictError);

    const forcedResult = await adapter.apply(context, { force: true });
    expect(forcedResult.filesWritten).toContain(userOwnedFile);

    await rm(root, { recursive: true, force: true });
  });

  it("removes stale SkillGate-managed files when skill selection changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lifecycle-"));
    const skill1 = join(root, "skill-one.md");
    const skill2 = join(root, "skill-two.md");
    await writeFile(skill1, "---\nname: skill-one\ndescription: Skill one\n---\n");
    await writeFile(skill2, "---\nname: skill-two\ndescription: Skill two\n---\n");

    const adapter = legacyCooperativeAdapter(new CodexAdapter());

    await adapter.apply({
      task: "task1",
      root,
      skills: [
        {
          path: skill1,
          metadata: { name: "skill-one", description: "Skill one" },
          score: 10,
          reasons: [],
        },
      ],
    });

    const skillOneFile = join(root, ".codex", "skills", "skill-one", "SKILL.md");
    expect(await readFile(skillOneFile, "utf8")).toContain("skill-one");

    const plan = await adapter.plan({
      task: "task2",
      root,
      skills: [
        {
          path: skill2,
          metadata: { name: "skill-two", description: "Skill two" },
          score: 10,
          reasons: [],
        },
      ],
    });

    expect(plan.removals).toContain(skillOneFile);

    const result = await adapter.apply({
      task: "task2",
      root,
      skills: [
        {
          path: skill2,
          metadata: { name: "skill-two", description: "Skill two" },
          score: 10,
          reasons: [],
        },
      ],
    });

    expect(result.filesRemoved).toContain(skillOneFile);

    await rm(root, { recursive: true, force: true });
  });

  it("cleans up managed files completely", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-lifecycle-"));
    const skill = join(root, "skill.md");
    await writeFile(skill, "---\nname: my-skill\ndescription: Skill\n---\n");

    const adapter = legacyCooperativeAdapter(new ClaudeCodeAdapter());
    const context = {
      task: "build",
      root,
      skills: [
        {
          path: skill,
          metadata: { name: "my-skill", description: "Skill" },
          score: 10,
          reasons: [],
        },
      ],
    };

    await adapter.apply(context);
    const cleanupResult = await adapter.cleanup(context);

    expect(cleanupResult.filesRemoved.length).toBeGreaterThan(0);

    await rm(root, { recursive: true, force: true });
  });
});
