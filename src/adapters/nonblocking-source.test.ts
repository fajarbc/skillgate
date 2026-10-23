import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
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

it.skipIf(process.platform === "win32")("rejects source entry replacement by a symlink to the original inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-symlink-swap-"));
  try {
    const source = join(root, "source.md");
    const moved = join(root, "moved.md");
    await writeFile(source, "# original bytes");
    const originalEntry = await lstat(source);
    await rename(source, moved);
    await symlink(moved, source);
    // Snapshot after the rename isolates pathname substitution from a ctime
    // change on the moved inode. stat() alone would accept this alias.
    const descriptorSnapshot = await stat(source);
    expect((await stat(source)).ino).toBe(descriptorSnapshot.ino);
    await expect(assertSourcePathSnapshot(source, descriptorSnapshot, originalEntry))
      .rejects.toBeInstanceOf(AdapterConflictError);
    // An unchanged symlink entry is still a supported source path.
    await expect(assertSourcePathSnapshot(source, descriptorSnapshot, await lstat(source)))
      .resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("rejects symlink source entry replacement even when the target is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-source-symlink-replaced-"));
  try {
    const target = join(root, "target.md");
    const source = join(root, "source.md");
    const oldLink = join(root, "old-link.md");
    await writeFile(target, "# stable target");
    await symlink(target, source);
    const descriptorSnapshot = await stat(source);
    const originalEntry = await lstat(source);
    await rename(source, oldLink);
    await symlink(target, source);
    expect((await stat(source)).ino).toBe(descriptorSnapshot.ino);
    await expect(assertSourcePathSnapshot(source, descriptorSnapshot, originalEntry))
      .rejects.toBeInstanceOf(AdapterConflictError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves metadata fallback only for a source absent at the initial path check", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-absent-source-fallback-"));
  try {
    const missing = join(root, "missing.md");
    const adapter = new CodexAdapter();
    const ctx = context(root, missing);
    expect((await adapter.plan(ctx)).conflicts).toEqual([]);
    await adapter.apply(ctx);
    const exposed = await readFile(join(root, ".codex", "skills", "sample", "SKILL.md"), "utf8");
    expect(exposed).toContain('name: "sample"');
    expect(exposed).toContain('description: "sample"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("escapes fallback metadata so it cannot inject frontmatter or instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-fallback-yaml-"));
  try {
    const missing = join(root, "missing.md");
    const ctx = context(root, missing);
    ctx.skills[0]!.metadata.description = "safe\n---\n# injected instruction";
    const adapter = new CodexAdapter();
    expect((await adapter.plan(ctx)).conflicts).toEqual([]);
    await adapter.apply(ctx);
    const exposed = await readFile(join(root, ".codex", "skills", "sample", "SKILL.md"), "utf8");
    expect(exposed).toContain('description: "safe\\n---\\n# injected instruction"');
    expect(exposed.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(exposed).not.toContain("\n# injected instruction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("escapes YAML Unicode line separators in fallback metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-fallback-unicode-"));
  try {
    const missing = join(root, "missing.md");
    const ctx = context(root, missing);
    const description = "safe\u2028---\u2028# injected\u0085continuation";
    ctx.skills[0]!.metadata.description = description;
    const adapter = new CodexAdapter();
    expect((await adapter.plan(ctx)).conflicts).toEqual([]);
    await adapter.apply(ctx);
    const exposed = await readFile(join(root, ".codex", "skills", "sample", "SKILL.md"), "utf8");
    expect(exposed).toContain("\\u2028");
    expect(exposed).toContain("\\u0085");
    const frontmatter = exposed.slice(OWNERSHIP_HEADER.length).split("\n---\n")[0]!;
    expect(parse(frontmatter.slice(4))).toEqual({ name: "sample", description });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects oversized manifest task metadata in both plan and apply without writing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-oversized-manifest-plan-"));
  try {
    // This cannot fit the 32 MiB ownership manifest even before path/digest fields.
    const task = "x".repeat(32 * 1024 * 1024 + 1);
    const adapter = new CodexAdapter();
    const ctx = { root, task, skills: [] };
    await expect(adapter.plan(ctx)).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(adapter.apply(ctx)).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(readFile(join(root, ".codex", "skills.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a near-limit task when the full pending manifest exceeds 32 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillgate-near-limit-manifest-"));
  try {
    const limit = 32 * 1024 * 1024;
    const task = "x".repeat(limit - 100);
    // The old metadata-only preflight accepted this, although the pending
    // manifest adds required ownership fields and pretty-printing overhead.
    expect(Buffer.byteLength(JSON.stringify({ task, skills: [] }), "utf8")).toBeLessThan(limit);
    const adapter = new CodexAdapter();
    const ctx = { root, task, skills: [] };
    await expect(adapter.plan(ctx)).rejects.toBeInstanceOf(AdapterConflictError);
    await expect(adapter.apply(ctx)).rejects.toBeInstanceOf(AdapterConflictError);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
