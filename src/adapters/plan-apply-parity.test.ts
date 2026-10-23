import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";

describe("adapter plan/apply parity", () => {
  it.each([
    ["Codex", ".codex", () => new CodexAdapter()],
    ["Claude Code", ".claude", () => new ClaudeCodeAdapter()],
  ])("keeps %s dry-run results consistent with reconciliation", async (_name, managedDir, createAdapter) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-plan-parity-"));
    try {
      const first = join(root, "first.md");
      const second = join(root, "second.md");
      await writeFile(first, "# First");
      await writeFile(second, "# Second");
      const skill = (path: string, name: string) => ({
        path, score: 1, reasons: [],
        metadata: { name, description: name, capabilities: [] },
      });
      const adapter = createAdapter();
      const original = { root, task: "parity", skills: [skill(first, "first"), skill(second, "second")] };
      await adapter.apply(original);
      const manifest = join(root, managedDir, "skills.json");
      const stale = join(root, managedDir, "skills", "second", "SKILL.md");
      const beforeManifest = await readFile(manifest, "utf8");
      const beforeStale = await readFile(stale, "utf8");
      const reduced = { ...original, skills: [skill(first, "first")] };
      const plan = await adapter.plan(reduced);
      expect(plan.conflicts).toEqual([]);
      expect(plan.removals).toEqual([stale]);
      expect(await readFile(manifest, "utf8")).toBe(beforeManifest);
      expect(await readFile(stale, "utf8")).toBe(beforeStale);
      const result = await adapter.apply(reduced);
      expect(result.filesWritten).toEqual(plan.writes);
      expect(result.filesRemoved).toEqual(plan.removals);
      await expect(readFile(stale, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const secondPlan = await adapter.plan(reduced);
      expect(secondPlan.removals).toEqual([]);
      const secondResult = await adapter.apply(reduced);
      expect(secondResult.filesWritten).toEqual(secondPlan.writes);
      expect(secondResult.filesRemoved).toEqual([]);
      expect(await readFile(first, "utf8")).toBe("# First");
      expect(await readFile(second, "utf8")).toBe("# Second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
