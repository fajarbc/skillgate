import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { getAdapter, listAdapters } from "./index.js";
import type { AdapterContext, AgentAdapter } from "./types.js";

/** Shared lifecycle contract: a new adapter only needs a factory and directory. */
const fixtures: Array<{ name: string; directory: string; factory: () => AgentAdapter }> = [
  { name: "codex", directory: ".codex", factory: () => new CodexAdapter() },
  { name: "claude-code", directory: ".claude", factory: () => new ClaudeCodeAdapter() },
];

function skill(root: string, name: string) {
  return {
    path: join(root, `${name}.md`),
    metadata: { name, description: "Shared adapter fixture" },
    score: 1,
    reasons: [],
  };
}

async function workspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skillgate-contract-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("adapter registration contract", () => {
  it("resolves canonical names and supported aliases", () => {
    expect(listAdapters()).toEqual(expect.arrayContaining(["codex", "claude", "claude-code"]));
    expect(getAdapter("codex")?.name).toBe("codex");
    expect(getAdapter("CLAUDE")?.name).toBe("claude-code");
    expect(getAdapter("claude-code")?.name).toBe("claude-code");
    expect(getAdapter("unknown")).toBeUndefined();
  });
});

for (const fixture of fixtures) {
  describe(`${fixture.name} shared lifecycle contract`, () => {
    it("formats and plans deterministically without touching the workspace", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const context: AdapterContext = { task: "contract", root, skills: [skill(root, "first")] };
      const formatted = await adapter.format(context);
      expect(formatted).toContain("first");
      const first = await adapter.plan!(context);
      expect(await adapter.plan!(context)).toEqual(first);
      expect(first).toEqual({
        agent: adapter.name,
        filesToWrite: expect.arrayContaining([
          join(root, fixture.directory, "skills", "first", "SKILL.md"),
          join(root, fixture.directory, "skills.json"),
        ]),
        filesToRemove: [],
        conflicts: [],
      });
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);
      expect(await readdir(root)).toEqual([]);
    }));

    it("applies the preview, is idempotent, and cleans only managed outputs", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const context: AdapterContext = { task: "contract", root, skills: [skill(root, "first")] };
      const plan = await adapter.plan!(context);
      const applied = await adapter.apply(context);
      expect(applied.agent).toBe(adapter.name);
      expect(applied.filesWritten).toEqual(plan.filesToWrite);
      expect(applied.exposedSkills).toEqual(["first"]);
      expect(typeof applied.summary).toBe("string");
      expect(JSON.parse(JSON.stringify(applied))).toEqual(applied);
      const before = await Promise.all(plan.filesToWrite.map((path) => readFile(path, "utf8")));
      const ownershipPath = join(root, fixture.directory, "skillgate-owned.json");
      const ownershipBefore = await readFile(ownershipPath, "utf8");
      const outputBefore = await stat(plan.filesToWrite[0]!);
      expect((await adapter.apply(context)).filesWritten).toEqual(plan.filesToWrite);
      const ownershipAfter = await readFile(ownershipPath, "utf8");
      const outputAfter = await stat(plan.filesToWrite[0]!);
      expect(ownershipAfter).toBe(ownershipBefore);
      expect(outputAfter.ino).toBe(outputBefore.ino);
      expect(outputAfter.mtimeMs).toBe(outputBefore.mtimeMs);
      expect(await Promise.all(plan.filesToWrite.map((path) => readFile(path, "utf8")))).toEqual(before);
      const personal = join(root, fixture.directory, "personal.txt");
      await writeFile(personal, "not managed");
      await adapter.cleanup!(context);
      await adapter.cleanup!(context);
      for (const path of plan.filesToWrite) {
        await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(personal, "utf8")).toBe("not managed");
    }));

    it("previews stale removal and preserves unrelated files", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const initial: AdapterContext = { task: "contract", root, skills: [skill(root, "first"), skill(root, "second")] };
      await adapter.apply(initial);
      const reduced = { ...initial, skills: [skill(root, "first")] };
      const stale = join(root, fixture.directory, "skills", "second", "SKILL.md");
      const personal = join(root, fixture.directory, "skills", "second", "notes.txt");
      await writeFile(personal, "keep me");
      const plan = await adapter.plan!(reduced);
      expect(plan.filesToRemove).toEqual([stale]);
      expect(plan.conflicts).toEqual([]);
      expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
      await adapter.apply(reduced);
      await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(personal, "utf8")).toBe("keep me");
    }));

    it("refuses unmanaged targets without overwriting them", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const context: AdapterContext = { task: "contract", root, skills: [skill(root, "first")] };
      const plan = await adapter.plan!(context);
      const target = plan.filesToWrite.find((path) => path.endsWith("SKILL.md"))!;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "personal content");
      expect((await adapter.plan!(context)).conflicts).toContain(target);
      await expect(adapter.apply(context)).rejects.toThrow("Refusing to overwrite existing adapter files");
      expect(await readFile(target, "utf8")).toBe("personal content");
    }));

    it("preflights every managed file before cleanup to avoid partial deletion", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const context: AdapterContext = {
        task: "contract", root, skills: [skill(root, "first"), skill(root, "second")],
      };
      await adapter.apply(context);
      const first = join(root, fixture.directory, "skills", "first", "SKILL.md");
      const second = join(root, fixture.directory, "skills", "second", "SKILL.md");
      const original = await readFile(first, "utf8");
      await writeFile(second, "user-edited content");
      await expect(adapter.cleanup!(context)).rejects.toThrow(/modified managed files/);
      expect(await readFile(first, "utf8")).toBe(original);
      expect(await readFile(second, "utf8")).toBe("user-edited content");
    }));

    it("rejects invalid metadata and collisions while containing traversal-like names", async () => workspace(async (root) => {
      const adapter = fixture.factory();
      const invalid: AdapterContext = { task: "contract", root, skills: [skill(root, "")] };
      await expect(adapter.plan!(invalid)).rejects.toThrow();
      const collision: AdapterContext = {
        task: "contract", root,
        skills: [skill(root, "First Skill"), skill(root, "first-skill")],
      };
      await expect(adapter.plan!(collision)).rejects.toThrow("Skill name collision");
      const traversal: AdapterContext = { task: "contract", root, skills: [skill(root, "../../escape")] };
      const plan = await adapter.plan!(traversal);
      for (const path of plan.filesToWrite) {
        const relativePath = relative(join(root, fixture.directory), path);
        expect(relativePath.startsWith("..")).toBe(false);
      }
      expect(await readdir(root)).toEqual([]);
    }));
  });
}
