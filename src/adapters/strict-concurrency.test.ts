import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFilesystemAdapter, cleanupFilesystemAdapter } from "./filesystem-lifecycle.js";

// The strict policy must reject before creating even an adapter root or lock.
describe("strict external-writer lifecycle policy", () => {
  for (const operation of ["apply", "cleanup"] as const) {
    it(`${operation} fails closed without mutating the workspace`, async () => {
      const root = await mkdtemp(join(tmpdir(), "skillgate-strict-"));
      try {
        const context = { root, task: "strict safety", skills: [] };
        const invoke = operation === "apply" ? applyFilesystemAdapter : cleanupFilesystemAdapter;
        await expect(invoke("codex", ".codex", context, { concurrency: "strict", force: true }))
          .rejects.toThrow(/Strict external-writer lifecycle safety is not supported/);
        expect(await readdir(root)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
