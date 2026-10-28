import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishImmutableGeneration, readImmutableGeneration, readPinnedGenerationFile } from "./immutable-generation.js";
import { putImmutableBlob } from "./immutable-store.js";

async function withStore(work: (store: string) => Promise<void>): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "skillgate-generation-test-"));
  try {
    await work(store);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

describe("pinned immutable adapter generations", () => {
  it("publishes sorted content and resolves every digest without a mutable pointer", async () => {
    await withStore(async (store) => {
      const first = await publishImmutableGeneration(store, "codex", "apply", {
        "skills/z.md": Buffer.from("Z"),
        "skills/a.md": Buffer.from("A"),
      });
      const second = await publishImmutableGeneration(store, "codex", "apply", {
        "skills/a.md": Buffer.from("A"),
        "skills/z.md": Buffer.from("Z"),
      });
      expect(second.digest).toBe(first.digest);
      expect(first.generation.files.map((file) => file.path)).toEqual(["skills/a.md", "skills/z.md"]);
      const resolved = await readImmutableGeneration(store, first.digest);
      expect(resolved.generation).toEqual(first.generation);
      expect(resolved.files.get("skills/a.md")?.toString("utf8")).toBe("A");
      expect(resolved.files.get("skills/z.md")?.toString("utf8")).toBe("Z");
      expect((await readdir(store)).every((name) => /^[a-f0-9]{64}$/.test(name))).toBe(true);
    });
  });

  it("represents cleanup as a tombstone without removing the previous generation", async () => {
    await withStore(async (store) => {
      const before = await publishImmutableGeneration(store, "claude-code", "apply", {
        "skills/a.md": Buffer.from("existing"),
      });
      const cleanup = await publishImmutableGeneration(store, "claude-code", "cleanup", {});
      expect(cleanup.generation.files).toEqual([]);
      expect((await readImmutableGeneration(store, cleanup.digest)).files.size).toBe(0);
      expect((await readImmutableGeneration(store, before.digest)).files.get("skills/a.md")?.toString())
        .toBe("existing");
    });
  });

  it("rejects traversal and malformed paths before writing any blob", async () => {
    await withStore(async (store) => {
      for (const path of ["../victim", "/absolute", "a//b", "a/./b", "a/../b",
        "a\\b", "a\0b", "bad\ud800"]) {
        await expect(publishImmutableGeneration(store, "codex", "apply", {
          [path]: Buffer.from("content"),
        })).rejects.toThrow(/logical path/);
      }
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("rejects cleanup with files and invalid identities before publication", async () => {
    await withStore(async (store) => {
      await expect(publishImmutableGeneration(store, "codex", "cleanup", {
        "skills/a.md": Buffer.from("A"),
      })).rejects.toThrow(/file count/);
      await expect(publishImmutableGeneration(store, "../codex", "apply", {}))
        .rejects.toThrow(/identity/);
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("rejects an authenticated blob containing an invalid manifest shape", async () => {
    await withStore(async (store) => {
      const blob = await putImmutableBlob(store, Buffer.from(JSON.stringify({
        schemaVersion: "1", agent: "codex", kind: "cleanup",
        files: [{ path: "skills/a.md", digest: "a".repeat(64), size: 1 }],
      })));
      await expect(readImmutableGeneration(store, blob.digest)).rejects.toThrow(/cleanup manifest/);
    });
  });

  it("rejects a missing referenced blob without trusting the manifest alone", async () => {
    await withStore(async (store) => {
      const published = await publishImmutableGeneration(store, "codex", "apply", {
        "skills/a.md": Buffer.from("A"),
      });
      await rm(join(store, published.generation.files[0]!.digest));
      await expect(readImmutableGeneration(store, published.digest)).rejects.toThrow();
    });
  });

  it("rejects a malformed manifest without reflecting its contents", async () => {
    await withStore(async (store) => {
      const blob = await putImmutableBlob(store, Buffer.from("{secret\n"));
      await expect(readImmutableGeneration(store, blob.digest))
        .rejects.toThrow("Invalid immutable generation manifest");
    });
  });

  it("does not overwrite an existing user-owned path outside the store", async () => {
    await withStore(async (store) => {
      const outside = await mkdtemp(join(tmpdir(), "skillgate-workspace-test-"));
      try {
        const victim = join(outside, "skills.md");
        await writeFile(victim, "user content");
        await publishImmutableGeneration(store, "codex", "apply", {
          "skills.md": Buffer.from("managed content"),
        });
        await publishImmutableGeneration(store, "codex", "cleanup", {});
        expect(await readFile(victim, "utf8")).toBe("user content");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
  it("captures all input buffers before publishing any file", async () => {
    await withStore(async (store) => {
      const first = Buffer.from("before-one");
      const second = Buffer.from("before-two");
      const pending = publishImmutableGeneration(store, "codex", "apply", {
        "skills/one.md": first,
        "skills/two.md": second,
      });
      first.fill(0x78);
      second.fill(0x79);
      const published = await pending;
      const resolved = await readImmutableGeneration(store, published.digest);
      expect(resolved.files.get("skills/one.md")?.toString()).toBe("before-one");
      expect(resolved.files.get("skills/two.md")?.toString()).toBe("before-two");
    });
  });

  it("concurrent identical generation publications converge on one pinned digest", async () => {
    await withStore(async (store) => {
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        publishImmutableGeneration(store, "codex", "apply", {
          "skills/a.md": Buffer.from("same content"),
        })));
      expect(new Set(results.map((result) => result.digest)).size).toBe(1);
      const resolved = await readImmutableGeneration(store, results[0]!.digest);
      expect(resolved.files.get("skills/a.md")?.toString()).toBe("same content");
      expect((await readdir(store)).every((name) => /^[a-f0-9]{64}$/.test(name))).toBe(true);
    });
  });

  it("reads only authenticated files from the requested agent and pinned digest", async () => {
    await withStore(async (store) => {
      const first = await publishImmutableGeneration(store, "codex", "apply", {
        "skills/a.md": Buffer.from("first"),
      });
      const second = await publishImmutableGeneration(store, "codex", "apply", {
        "skills/a.md": Buffer.from("second"),
      });
      expect((await readPinnedGenerationFile(store, first.digest, "skills/a.md", "codex"))?.toString()).toBe("first");
      expect((await readPinnedGenerationFile(store, second.digest, "skills/a.md", "codex"))?.toString()).toBe("second");
      expect(await readPinnedGenerationFile(store, first.digest, "skills/missing.md", "codex")).toBeNull();
      await expect(readPinnedGenerationFile(store, first.digest, "../escape", "codex")).rejects.toThrow();
      await expect(readPinnedGenerationFile(store, first.digest, "skills/a.md", "claude-code")).rejects.toThrow(/another agent/);
      const tombstone = await publishImmutableGeneration(store, "codex", "cleanup", {});
      expect(await readPinnedGenerationFile(store, tombstone.digest, "skills/a.md", "codex")).toBeNull();
    });
  });


});
