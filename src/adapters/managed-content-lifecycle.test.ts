import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";
import { OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";

describe.each([
  { name: "Codex", rootName: ".codex", adapter: () => new CodexAdapter() },
  { name: "Claude", rootName: ".claude", adapter: () => new ClaudeCodeAdapter() },
])("$name managed content integrity", ({ rootName, adapter }) => {
  it("preserves a user edit retaining the ownership marker during plan, apply and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-digest-"));
    try {
      const source = join(root, "source.md");
      await writeFile(source, "# Original");
      const context = {
        root, task: "test", skills: [{
          path: source, metadata: { name: "example", description: "Example" },
          score: 1, reasons: [],
        }],
      };
      const host = adapter();
      await host.apply(context);
      const target = join(root, rootName, "skills", "example", "SKILL.md");
      const manifestPath = join(root, rootName, "skills.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.managedHashes?.[target]).toMatch(/^[a-f0-9]{64}$/);
      const edited = OWNERSHIP_HEADER + "# Edited by user";
      await writeFile(target, edited);
      expect((await host.plan(context)).conflicts).toContain(target);
      await expect(host.apply(context)).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe(edited);
      const cleanup = await host.cleanup(context);
      expect(cleanup.filesRemoved).not.toContain(target);
      expect(cleanup.filesRemoved).not.toContain(manifestPath);
      expect(await readFile(target, "utf8")).toBe(edited);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
