import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFilesystemAdapter, cleanupFilesystemAdapter } from "./filesystem-lifecycle.js";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";

// Option B is the default; neither force nor a missing policy can opt into
// path-based replacement/removal. The backend must reject before mutation.
describe("strict external-writer lifecycle policy", () => {
  it.each([
    ["Codex", () => new CodexAdapter()],
    ["Claude Code", () => new ClaudeCodeAdapter()],
  ] as const)("%s public adapter never bypasses strict defaults", async (_name, createAdapter) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-strict-public-"));
    const sentinel = join(root, "user-owned.txt");
    try {
      await writeFile(sentinel, "protected");
      const context = { root, task: "strict public API", skills: [] };
      const adapter = createAdapter();
      await expect(adapter.apply(context)).rejects.toThrow(/Strict external-writer lifecycle safety is not supported/);
      await expect(adapter.cleanup(context, { force: true })).rejects.toThrow(/Strict external-writer lifecycle safety is not supported/);
      expect(await readdir(root)).toEqual(["user-owned.txt"]);
      expect(await readFile(sentinel, "utf8")).toBe("protected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const operation of ["apply", "cleanup"] as const) {
    for (const options of [undefined, { force: true }, { concurrency: "strict" as const, force: true }]) {
      it(`${operation} fails closed for ${JSON.stringify(options)} without workspace mutation`, async () => {
        const root = await mkdtemp(join(tmpdir(), "skillgate-strict-"));
        const sentinel = join(root, "user-owned.txt");
        try {
          await writeFile(sentinel, "user-owned bytes");
          const context = { root, task: "strict safety", skills: [] };
          const invoke = operation === "apply" ? applyFilesystemAdapter : cleanupFilesystemAdapter;
          await expect(invoke("codex", ".codex", context, options))
            .rejects.toThrow(/Strict external-writer lifecycle safety is not supported/);
          expect(await readdir(root)).toEqual(["user-owned.txt"]);
          expect(await readFile(sentinel, "utf8")).toBe("user-owned bytes");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});
