import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAdapter } from "./codex.js";
import { AdapterConflictError, OWNERSHIP_HEADER, assertSourcePathSnapshot, writeManagedFile } from "./filesystem-lifecycle.js";

function context(root: string, path: string) {
  return { task: "non-regular-source", root, skills: [{
    path, score: 1, reasons: [],
    metadata: { name: "sample", description: "sample", capabilities: [] },
  }] };
}

it.skipIf(process.platform === "win32")("rejects FIFO skill sources without creating ownership state", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-fifo-"));
  try {
    const source = join(root, "source.fifo");
    const created = spawnSync("mkfifo", [source], { timeout: 3000 });
    if ((created.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    expect(created.status).toBe(0);
    await expect(new CodexAdapter().apply(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects directory skill sources without creating ownership state", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-directory-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await expect(new CodexAdapter().apply(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([32 * 1024 * 1024, 32 * 1024 * 1024 + 1])("rejects oversized skill sources of %i bytes", async (size) => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-oversized-"));
  try {
    const source = join(root, "large.md");
    await writeFile(source, "x");
    await truncate(source, size);
    await expect(new CodexAdapter().apply(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([0, 32 * 1024 * 1024 - Buffer.byteLength(OWNERSHIP_HEADER)])("accepts regular skill source of %i bytes", async (size) => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-boundary-"));
  try {
    const source = join(root, "source.md");
    await writeFile(source, "");
    await truncate(source, size);
    const adapter = new CodexAdapter();
    const result = await adapter.apply(context(root, source));
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect((await adapter.plan(context(root, source))).conflicts).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects oversized pending manifests before creating the adapter root", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-manifest-size-"));
  try {
    const source = join(root, "small.md");
    await writeFile(source, "small");
    const ctx = context(root, source);
    ctx.skills[0]!.metadata.description = "x".repeat(32 * 1024 * 1024);
    await expect(new CodexAdapter().apply(ctx)).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(stat(join(root, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects oversized managed writes before staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-managed-write-limit-"));
  try {
    await expect(writeManagedFile(join(root, "oversized.md"), "x".repeat(32 * 1024 * 1024 + 1)))
      .rejects.toBeInstanceOf(AdapterConflictError);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("plan rejects FIFO sources without creating ownership state", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-plan-fifo-"));
  try {
    const source = join(root, "source.fifo");
    const created = spawnSync("mkfifo", [source], { timeout: 3000 });
    if ((created.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    expect(created.status).toBe(0);
    await expect(new CodexAdapter().plan(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("plan rejects directory and oversized sources without creating ownership state", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-plan-source-"));
  try {
    const directory = join(root, "directory");
    await mkdir(directory);
    await expect(new CodexAdapter().plan(context(root, directory))).rejects.toBeInstanceOf(AdapterConflictError);
    const oversized = join(root, "oversized.md");
    await writeFile(oversized, "x");
    await truncate(oversized, 32 * 1024 * 1024 + 1);
    await expect(new CodexAdapter().plan(context(root, oversized))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects small malformed UTF-8 skill sources consistently in plan and apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-invalid-utf8-"));
  try {
    const source = join(root, "invalid.md");
    // An invalid continuation byte must not be silently replaced with U+FFFD.
    await writeFile(source, Buffer.from([0x23, 0x20, 0x80, 0x0a]));
    const adapter = new CodexAdapter();
    await expect(adapter.plan(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(adapter.apply(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("plan rejects UTF-8 replacement expansion beyond the managed-source limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-plan-utf8-"));
  try {
    const source = join(root, "invalid.md");
    await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xff));
    await expect(new CodexAdapter().plan(context(root, source))).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("detects source pathname replacement even when replacement bytes are identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-path-snapshot-"));
  try {
    const source = join(root, "source.md");
    const moved = join(root, "moved.md");
    await writeFile(source, "# identical content");
    const originalSnapshot = await stat(source);
    await expect(assertSourcePathSnapshot(source, originalSnapshot)).resolves.toBeUndefined();
    // Retain the original inode under another name, then put identical bytes
    // at the source pathname. Size/content checks alone cannot detect this.
    await rename(source, moved);
    await writeFile(source, "# identical content");
    await expect(assertSourcePathSnapshot(source, originalSnapshot))
      .rejects.toBeInstanceOf(AdapterConflictError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("detects a source pathname removed after descriptor validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-path-missing-"));
  try {
    const source = join(root, "source.md");
    await writeFile(source, "# source");
    const originalSnapshot = await stat(source);
    await rm(source);
    await expect(assertSourcePathSnapshot(source, originalSnapshot))
      .rejects.toBeInstanceOf(AdapterConflictError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
