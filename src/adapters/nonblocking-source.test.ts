import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexAdapter } from "./codex.js";
import { AdapterConflictError } from "./filesystem-lifecycle.js";

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
