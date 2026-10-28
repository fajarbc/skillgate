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
});
