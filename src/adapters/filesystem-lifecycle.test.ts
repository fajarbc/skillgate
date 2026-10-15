import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPreviousManifest } from "./filesystem-lifecycle.js";

describe("adapter ownership manifest validation", () => {
  it.each([
    { agent: "claude-code", version: "1.0", expected: "codex" },
    { agent: "codex", version: "2.0", expected: "codex" },
    { agent: "codex", version: "1.0", expected: "codex" },
  ])("accepts only the supported version for the expected adapter: $agent/$version", async ({ agent, version, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-manifest-validation-"));
    try {
      const path = join(root, "skills.json");
      const manifest = {
        managedBy: "skillgate", version, agent, task: "test",
        updatedAt: "2026-01-01", managedFiles: [path], skills: [],
      };
      await writeFile(path, JSON.stringify(manifest));
      const loaded = await readPreviousManifest(path, expected);
      if (agent === expected && version === "1.0") {
        expect(loaded).toEqual(manifest);
      } else {
        expect(loaded).toBeNull();
      }
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
