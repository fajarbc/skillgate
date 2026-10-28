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
  it("rejects oversized input before staging any file", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const { MAX_IMMUTABLE_BLOB_BYTES } = await import("./immutable-store.js");
      const { readdir } = await import("node:fs/promises");
      await expect(putImmutableBlob(store, Buffer.alloc(MAX_IMMUTABLE_BLOB_BYTES + 1)))
        .rejects.toThrow(/32 MiB/);
      expect(await readdir(store)).toEqual([]);
    } finally { await rm(store, { recursive: true, force: true }); }
  });

  it("rejects a writable collision even when its bytes match the digest", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const { createHash } = await import("node:crypto");
      const digest = createHash("sha256").update("alpha").digest("hex");
      await writeFile(join(store, digest), "alpha", { mode: 0o600 });
      await expect(putImmutableBlob(store, Buffer.from("alpha")))
        .rejects.toThrow(/unsafe entry/);
      expect(await readFile(join(store, digest), "utf8")).toBe("alpha");
    } finally { await rm(store, { recursive: true, force: true }); }
  });

  it("publishes read-only blobs under concurrent create attempts", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () =>
        putImmutableBlob(store, Buffer.from("same immutable content"))));
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(results.map((result) => result.path)).size).toBe(1);
      const { stat, readdir } = await import("node:fs/promises");
      const entry = await stat(results[0]!.path);
      expect(entry.mode & 0o222).toBe(0);
      expect((await readdir(store)).filter((name) => name.startsWith(".stage-"))).toEqual([]);
    } finally { await rm(store, { recursive: true, force: true }); }
  });

  it("rejects a group-writable store before creating any staging entry", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const { chmod, readdir } = await import("node:fs/promises");
      await chmod(store, 0o770);
      await expect(putImmutableBlob(store, Buffer.from("alpha")))
        .rejects.toThrow(/private POSIX directory/);
      expect(await readdir(store)).toEqual([]);
    } finally { await rm(store, { recursive: true, force: true }); }
  });

  it("never follows a symlink at the digest destination", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    const outside = await mkdtemp(join(tmpdir(), "skillgate-blob-outside-"));
    try {
      const { createHash } = await import("node:crypto");
      const { symlink } = await import("node:fs/promises");
      const digest = createHash("sha256").update("alpha").digest("hex");
      const target = join(outside, "victim");
      await writeFile(target, "alpha");
      await symlink(target, join(store, digest));
      await expect(putImmutableBlob(store, Buffer.from("alpha"))).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("alpha");
    } finally {
      await rm(store, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("snapshots caller-owned buffers before asynchronous I/O", async () => {
    const store = await mkdtemp(join(tmpdir(), "skillgate-blob-test-"));
    try {
      const input = Buffer.from("original");
      const pending = putImmutableBlob(store, input);
      input.fill(0x78);
      const result = await pending;
      const { readImmutableBlob } = await import("./immutable-store.js");
      expect((await readImmutableBlob(store, result.digest)).toString()).toBe("original");
      await expect(readImmutableBlob(store, "../outside")).rejects.toThrow(/digest/);
    } finally { await rm(store, { recursive: true, force: true }); }
  });

});
