import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { putImmutableBlob } from "./immutable-store.js";

describe("create-only immutable blob storage", () => {
  it("reuses identical blobs without replacing their directory entries", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const first = await putImmutableBlob(store, Buffer.from("alpha"));
      const second = await putImmutableBlob(store, Buffer.from("alpha"));
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      expect(await readFile(first.path, "utf8")).toBe("alpha");
    } finally { await rm(store, { recursive: true, force: true }); }
  });

  it("rejects a pre-existing entry with the expected digest name but wrong bytes", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256").update("alpha").digest("hex");
      await writeFile(join(store, digest), "tampered");
      await expect(putImmutableBlob(store, Buffer.from("alpha"))).rejects.toThrow(/collision/);
      expect(await readFile(join(store, digest), "utf8")).toBe("tampered");
    } finally { await rm(store, { recursive: true, force: true }); }
  });
});
