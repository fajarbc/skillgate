import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { putImmutableBlob, readImmutableBlob } from "./immutable-store.js";

// These tests deliberately use an unrelated OS process with the same UID.
// POSIX 0700 directories and 0400 files do NOT isolate that process. They
// document the missing Option B trust boundary, not a completed safety proof.
describe("same-UID immutable-store adversary", () => {
  it("can rewrite a published read-only inode; digest reads fail closed", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const store = await mkdtemp(join(tmpdir(), "skillgate-same-uid-"));
    try {
      const original = Buffer.from("trusted content");
      const published = await putImmutableBlob(store, original);
      expect((await stat(published.path)).mode & 0o222).toBe(0);

      const writer = spawnSync(process.execPath, [
        "-e",
        "const fs = require('node:fs'); fs.chmodSync(process.argv[1], 0o600); fs.writeFileSync(process.argv[1], 'attacker content');",
        published.path,
      ], { encoding: "utf8", timeout: 5000 });
      expect(writer.error).toBeUndefined();
      expect(writer.status).toBe(0);
      expect(await readFile(published.path, "utf8")).toBe("attacker content");
      await expect(readImmutableBlob(store, published.digest))
        .rejects.toThrow(/collision or unsafe entry/);
      await expect(putImmutableBlob(store, original))
        .rejects.toThrow(/collision or unsafe entry/);
      // No automatic overwrite or unlink is permitted on a digest collision.
      expect(await readFile(published.path, "utf8")).toBe("attacker content");
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("can replace a private store directory under a same-UID ancestor", async () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const parent = await mkdtemp(join(tmpdir(), "skillgate-same-uid-parent-"));
    const store = join(parent, "private");
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(store, { mode: 0o700 });
      const published = await putImmutableBlob(store, Buffer.from("original"));
      const writer = spawnSync(process.execPath, [
        "-e",
        "const fs = require('node:fs'); fs.renameSync(process.argv[1], process.argv[2]); fs.mkdirSync(process.argv[1], {mode: 0o700});",
        store, join(parent, "displaced"),
      ], { encoding: "utf8", timeout: 5000 });
      expect(writer.error).toBeUndefined();
      expect(writer.status).toBe(0);
      await expect(readImmutableBlob(store, published.digest)).rejects.toThrow();
      // The original generation was not modified, but the pathname no longer
      // identifies it. A protected ancestor or separate-UID broker is required.
      expect(await readFile(join(parent, "displaced", published.digest), "utf8"))
        .toBe("original");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
