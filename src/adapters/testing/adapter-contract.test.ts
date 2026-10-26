import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AdapterContext, LifecycleOptions } from "../types.js";
import type { RankedSkill } from "../../ranking/index.js";

/**
 * Legacy lifecycle tests intentionally exercise the cooperating-writer backend.
 * Production adapters are strict-by-default; never use this fixture for
 * strict-policy tests or mistake these tests for Option B concurrency evidence.
 */
export function legacyCooperativeAdapter<T extends AgentAdapter>(adapter: T): T {
  const apply = adapter.apply.bind(adapter);
  const cleanup = adapter.cleanup.bind(adapter);
  return Object.assign(adapter, {
    apply: (context: AdapterContext, options?: LifecycleOptions) =>
      apply(context, { ...options, concurrency: "cooperative" }),
    cleanup: (context: AdapterContext, options?: LifecycleOptions) =>
      cleanup(context, { ...options, concurrency: "cooperative" }),
  });
}

export interface AdapterContractConfig {
  readonly label: string;
  readonly createAdapter: () => AgentAdapter;
  readonly managedDirectory: string;
  readonly expectedAgent: string;
}

export function makeSkill(root: string, name: string, description = `${name} description`): RankedSkill {
  return {
    path: join(root, `${name.replace(/[^a-z0-9]+/gi, "-") || "skill"}.md`),
    metadata: { name, description, capabilities: ["testing"] },
    score: 10,
    reasons: [],
  };
}

export async function writeSkill(skill: RankedSkill, content = "# Instructions\nRun the skill.\n"): Promise<void> {
  await writeFile(skill.path, content, "utf8");
}

// This module is intentionally named *.test.ts so the reusable helpers cannot
// leak into the production build. Keep one small self-test so Vitest can also
// discover the helper module directly without reporting an empty suite.
describe("adapter contract fixtures", () => {
  it("creates a valid ranked skill fixture", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "skillgate-fixture-"));
    try {
      const skill = makeSkill(fixtureRoot, "fixture");
      expect(skill.metadata.name).toBe("fixture");
      expect(skill.path).toBe(join(fixtureRoot, "fixture.md"));
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

async function filesUnder(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.set(path, await readFile(path, "utf8"));
    }
  }
  await visit(root);
  return result;
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        result.set(path, `symlink:${await readlink(path)}`);
      } else if (entry.isDirectory()) {
        result.set(path, "directory");
        await visit(path);
      } else {
        result.set(path, `file:${(await readFile(path)).toString("hex")}`);
      }
    }
  }
  await visit(root);
  return result;
}

export function runAdapterContractSuite(config: AdapterContractConfig): void {
  describe(`${config.label} adapter contract`, () => {
    let root: string;
    let adapter: AgentAdapter;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "skillgate-adapter-contract-"));
      adapter = config.createAdapter();
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    function context(skills: RankedSkill[], task = "contract task"): AdapterContext {
      return { task, root, skills };
    }

    it("formats deterministically without mutating the fixture tree", async () => {
      const skill = makeSkill(root, "format-skill");
      await writeSkill(skill);
      const initial = await snapshotTree(root);
      const first = await adapter.format(context([skill]));
      expect(await snapshotTree(root)).toEqual(initial);
      const second = await adapter.format(context([skill]));
      expect(await snapshotTree(root)).toEqual(initial);
      expect(second).toBe(first);
      expect(first).toContain(skill.metadata.name);
      await adapter.apply(context([skill]));
      const before = await snapshotTree(root);
      expect(await adapter.format(context([skill]))).toBe(first);
      expect(await snapshotTree(root)).toEqual(before);
    });

    it("plans deterministically without mutating the fixture tree", async () => {
      const skill = makeSkill(root, "planned");
      await writeSkill(skill);
      const selected = context([skill]);
      const initial = await snapshotTree(root);
      const firstPlan = await adapter.plan(selected);
      expect(await snapshotTree(root)).toEqual(initial);
      await adapter.apply(selected);
      const before = await snapshotTree(root);
      const secondPlan = await adapter.plan(selected);
      expect(await snapshotTree(root)).toEqual(before);
      const thirdPlan = await adapter.plan(selected);
      expect(secondPlan).toEqual(thirdPlan);
      expect(await snapshotTree(root)).toEqual(before);
      expect(firstPlan.writes).toEqual(secondPlan.writes);
      expect(firstPlan.removals).toEqual([]);
    });

    it("makes plan writes correspond exactly to apply writes", async () => {
      const first = makeSkill(root, "first");
      const second = makeSkill(root, "second");
      await Promise.all([writeSkill(first), writeSkill(second)]);
      const selected = context([first, second]);
      const plan = await adapter.plan(selected);
      const result = await adapter.apply(selected);
      expect(result.filesWritten).toEqual(plan.writes);
      expect(result.filesRemoved ?? []).toEqual(plan.removals);
      expect(result.exposedSkills).toEqual(["first", "second"]);
    });

    it("is idempotent in content and manifest bytes", async () => {
      const skill = makeSkill(root, "repeat");
      await writeSkill(skill, "# Stable content\n");
      const selected = context([skill], "repeat task");
      const first = await adapter.apply(selected);
      const firstFiles = await filesUnder(join(root, config.managedDirectory));
      const second = await adapter.apply(selected);
      const secondFiles = await filesUnder(join(root, config.managedDirectory));
      expect(secondFiles).toEqual(firstFiles);
      expect(second.filesWritten).toEqual(first.filesWritten);
      expect(second.filesRemoved ?? []).toEqual([]);
    });

    it("removes stale managed skills while retaining the current selection", async () => {
      const stale = makeSkill(root, "stale");
      const current = makeSkill(root, "current");
      await Promise.all([writeSkill(stale), writeSkill(current)]);
      await adapter.apply(context([stale, current], "initial"));
      const stalePath = join(root, config.managedDirectory, "skills", "stale", "SKILL.md");
      const next = context([current], "reconcile");
      const plan = await adapter.plan(next);
      expect(plan.removals).toContain(stalePath);
      const result = await adapter.apply(next);
      expect(result.filesRemoved ?? []).toContain(stalePath);
      await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, config.managedDirectory, "skills", "current", "SKILL.md"))).resolves.toBeDefined();
    });

    it("reports unowned conflicts and overwrites only with force", async () => {
      const skill = makeSkill(root, "owned");
      await writeSkill(skill);
      const selected = context([skill]);
      await adapter.apply(selected);
      const destination = join(root, config.managedDirectory, "skills", "owned", "SKILL.md");
      await writeFile(destination, "user-owned bytes\n", "utf8");
      const plan = await adapter.plan(selected);
      expect(plan.conflicts).toContain(destination);
      await expect(adapter.apply(selected)).rejects.toThrow();
      expect(await readFile(destination, "utf8")).toBe("user-owned bytes\n");
      const forced = await adapter.apply(selected, { force: true });
      expect(forced.filesWritten).toContain(destination);
      expect(await readFile(destination, "utf8")).toContain("# Instructions");
    });

    it("cleans up managed files idempotently without deleting user content", async () => {
      const skill = makeSkill(root, "cleanup");
      await writeSkill(skill);
      const selected = context([skill]);
      const applied = await adapter.apply(selected);
      const userPath = join(root, config.managedDirectory, "notes.txt");
      await writeFile(userPath, "user notes\n");
      const cleaned = await adapter.cleanup(selected);
      expect(cleaned.agent).toBe(config.expectedAgent);
      expect([...cleaned.filesRemoved].sort()).toEqual([...applied.filesWritten].sort());
      expect(typeof cleaned.summary).toBe("string");
      expect(JSON.parse(JSON.stringify(cleaned))).toEqual(cleaned);
      for (const path of applied.filesWritten) {
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(userPath, "utf8")).toBe("user notes\n");
      expect((await adapter.cleanup(selected)).filesRemoved).toEqual([]);
    });

    it("preserves user-replaced skill files during cleanup", async () => {
      const skill = makeSkill(root, "edited");
      await writeSkill(skill);
      const selected = context([skill]);
      await adapter.apply(selected);
      const destination = join(root, config.managedDirectory, "skills", "edited", "SKILL.md");
      await writeFile(destination, "user replacement\n");
      const cleaned = await adapter.cleanup(selected);
      expect(cleaned.filesRemoved).not.toContain(destination);
      expect(await readFile(destination, "utf8")).toBe("user replacement\n");
    });

    it("rejects a symlinked adapter root without touching its target", async () => {
      const outside = join(root, "outside-target");
      await mkdir(outside);
      await writeFile(join(outside, "sentinel.txt"), "untouched\n");
      await symlink(outside, join(root, config.managedDirectory), "junction");
      const before = await filesUnder(outside);
      const selected = context([]);
      await expect(adapter.plan(selected)).rejects.toThrow(/symlink/i);
      await expect(adapter.apply(selected)).rejects.toThrow(/symlink/i);
      await expect(adapter.cleanup(selected)).rejects.toThrow(/symlink/i);
      expect(await filesUnder(outside)).toEqual(before);
    });

    it.each([
      { name: "", reason: /Invalid skill name/ },
      { name: "   ...   ", reason: /Unsafe skill name/ },
      { name: null as unknown as string, reason: /Invalid skill name/ },
    ])("rejects invalid metadata name $name", async ({ name, reason }) => {
      const invalid = makeSkill(root, "invalid");
      invalid.metadata.name = name;
      await writeSkill(invalid);
      await expect(adapter.plan(context([invalid]))).rejects.toThrow(reason);
      expect(await filesUnder(join(root, config.managedDirectory))).toEqual(new Map());
    });

    it("contains traversal-like names and rejects normalized collisions", async () => {
      const traversal = makeSkill(root, "traversal");
      traversal.metadata.name = "../../outside";
      await writeSkill(traversal);
      const plan = await adapter.plan(context([traversal]));
      expect(plan.writes.every((path) => path.startsWith(join(root, config.managedDirectory)))).toBe(true);
      await adapter.apply(context([traversal]));
      await expect(stat(join(root, "outside", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

      const one = makeSkill(root, "one");
      const two = makeSkill(root, "two");
      one.metadata.name = "same-name";
      two.metadata.name = "Same_Name";
      await Promise.all([writeSkill(one), writeSkill(two)]);
      await expect(adapter.plan(context([one, two]))).rejects.toThrow(/Skill name collision/);
    });

    it("returns JSON-shaped results with adapter identity and exposed skills", async () => {
      const skill = makeSkill(root, "json-result");
      await writeSkill(skill);
      const result = await adapter.apply(context([skill]));
      expect(result.agent).toBe(config.expectedAgent);
      expect(result.exposedSkills).toEqual(["json-result"]);
      expect(Array.isArray(result.filesWritten)).toBe(true);
      expect(Array.isArray(result.filesRemoved)).toBe(true);
      expect(typeof result.summary).toBe("string");
      expect(() => JSON.stringify(result)).not.toThrow();
      const plan = await adapter.plan(context([skill]));
      expect(plan.agent).toBe(config.expectedAgent);
      expect(plan.skills).toEqual(["json-result"]);
      expect(() => JSON.stringify(plan)).not.toThrow();
    });
  });
}
