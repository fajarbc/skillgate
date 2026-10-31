import { legacyCooperativeAdapter } from "./testing/adapter-contract.test.js";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";

it.skipIf(process.platform === "win32")("resolves symlinked TMPDIR", async () => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "skillgate-tmp-"));
  const previous = process.env.TMPDIR;
  try {
    await mkdir(join(base, "actual"));
    await symlink(join(base, "actual"), join(base, "alias"), "dir");
    process.env.TMPDIR = join(base, "alias");
    const context = { task: "test", root: join(base, "workspace"), skills: [] };
    const adapter = legacyCooperativeAdapter(new CodexAdapter());
    expect((await adapter.apply(context)).filesWritten.length).toBeGreaterThan(0);
    await adapter.cleanup(context);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(base, { recursive: true, force: true });
  }
});