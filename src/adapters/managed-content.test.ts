import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isManagedFile, OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";

describe("managed-file content integrity", () => {
  it("preserves files edited after SkillGate writes them, even when the marker remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-integrity-"));
    try {
      const target = join(root, "SKILL.md");
      const original = OWNERSHIP_HEADER + "# Original";
      await writeFile(target, original);
      const manifest = {
        managedBy: "skillgate" as const, version: "1.0" as const,
        agent: "codex", task: "test", updatedAt: "2026-01-01",
        managedFiles: [target], skills: [],
        managedHashes: { [target]: createHash("sha256").update(original).digest("hex") },
      };
      expect(await isManagedFile(target, manifest)).toBe(true);
      await writeFile(target, OWNERSHIP_HEADER + "# User modification");
      expect(await readFile(target, "utf8")).toContain("User modification");
      expect(await isManagedFile(target, manifest)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
