import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A missing kernel flag must not be treated as zero. In particular, opening a
// FIFO without O_NONBLOCK can hang, and following a symlink can escape the
// validated store namespace. Mock the platform constants, not the I/O layer.
describe("immutable store kernel prerequisites", () => {
  it.each(["O_NOFOLLOW", "O_NONBLOCK", "O_DIRECTORY"] as const)(
    "fails closed before staging when %s is unavailable", async (missing) => {
      const store = await mkdtemp(join(tmpdir(), "skillgate-flags-"));
      try {
        vi.resetModules();
        vi.doMock("node:fs", async (importOriginal) => {
          const actual = await importOriginal<typeof import("node:fs")>();
          return {
            ...actual,
            constants: { ...actual.constants, [missing]: undefined },
          };
        });
        const { putImmutableBlob } = await import("./immutable-store.js");
        await expect(putImmutableBlob(store, Buffer.from("managed")))
          .rejects.toThrow(/requires POSIX ownership and safe open flags/);
        expect(await readdir(store)).toEqual([]);
      } finally {
        vi.doUnmock("node:fs");
        vi.resetModules();
        await rm(store, { recursive: true, force: true });
      }
    },
  );

  it("rejects a store symlink substitution before directory fsync", async () => {
    if (process.platform === "win32") return;
    const { constants } = await import("node:fs");
    const { mkdir, readdir } = await import("node:fs/promises");
    const parent = await mkdtemp(join(tmpdir(), "skillgate-swap-"));
    const store = join(parent, "private");
    const displaced = join(parent, "displaced");
    const outside = join(parent, "outside");
    await mkdir(store, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    let swapped = false;
    try {
      vi.resetModules();
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          open: async (path: string, flags: number, mode?: number) => {
            if (!swapped && path === store && (flags & constants.O_DIRECTORY) !== 0) {
              swapped = true;
              await actual.rename(store, displaced);
              await actual.symlink(outside, store, "dir");
            }
            return actual.open(path, flags, mode);
          },
        };
      });
      const { putImmutableBlob } = await import("./immutable-store.js");
      await expect(putImmutableBlob(store, Buffer.from("managed"))).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(parent, { recursive: true, force: true });
    }
  });
  it("fsyncs a reused digest after an interrupted directory sync", async () => {
    if (process.platform === "win32") return;
    const { constants } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const store = await mkdtemp(join(tmpdir(), "skillgate-retry-sync-"));
    let directorySyncs = 0;
    try {
      vi.resetModules();
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs/promises")>();
        return {
          ...actual,
          open: async (path: string, flags: number, mode?: number) => {
            const handle = await actual.open(path, flags, mode);
            if (path === store && (flags & constants.O_DIRECTORY) !== 0) {
              directorySyncs++;
              if (directorySyncs === 1) {
                // The content inode and digest link are already visible.
                // Simulate an interrupted directory sync before success.
                handle.sync = async () => {
                  throw new Error("injected directory sync failure");
                };
              }
            }
            return handle;
          },
        };
      });
      const { putImmutableBlob, readImmutableBlob } = await import("./immutable-store.js");
      const content = Buffer.from("durable after retry");
      const digest = createHash("sha256").update(content).digest("hex");
      await expect(putImmutableBlob(store, content))
        .rejects.toThrow(/injected directory sync failure/);
      expect(await readdir(store)).toEqual([digest]);
      const recovered = await putImmutableBlob(store, content);
      expect(recovered.created).toBe(false);
      expect(recovered.digest).toBe(digest);
      expect(directorySyncs).toBe(2);
      expect(await readImmutableBlob(store, digest)).toEqual(content);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(store, { recursive: true, force: true });
    }
  });

});
