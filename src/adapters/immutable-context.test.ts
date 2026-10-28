import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";
import { OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";

async function withFixture(work: (root: string, store: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skillgate-context-workspace-"));
  const store = await mkdtemp(join(tmpdir(), "skillgate-context-store-"));
  try {
    await work(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

describe("immutable context adapter integration", () => {
  it("plans and publishes real Codex skills without modifying user-owned legacy files", async () => {
    await withFixture(async (root, store) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Actual skill source\n");
      const legacy = join(root, ".codex", "skills", "example", "SKILL.md");
      await mkdir(join(root, ".codex", "skills", "example"), { recursive: true });
      await writeFile(legacy, "USER-OWNED CONTENT");
      const context = { root, task: "example task", skills: [{
        path: source, metadata: { name: "Example", description: "Example skill" },
        score: 42, reasons: [],
      }] };
      const adapter = new CodexAdapter().immutable(store);
      const preview = await adapter.planContext(context);
      expect(await readdir(store)).toEqual([]);
      const applied = await adapter.applyContext(context);
      expect(applied.digest).toBe(preview.digest);
      expect(applied.generation).toEqual(preview.generation);
      expect((await adapter.readFile(applied.digest, "skills/example/SKILL.md"))?.toString())
        .toBe(OWNERSHIP_HEADER + "# Actual skill source\n");
      const manifest = JSON.parse((await adapter.readFile(applied.digest, "skills.json"))!.toString());
      expect(manifest.task).toBe("example task");
      expect(manifest.skills[0].path).toBe("skills/example/SKILL.md");
      const resolvedContext = await adapter.readContext(applied.digest);
      expect(resolvedContext?.task).toBe("example task");
      expect(resolvedContext?.skills[0]?.identifier).toBe("example");
      expect(resolvedContext?.files.get("skills/example/SKILL.md")?.toString())
        .toBe(OWNERSHIP_HEADER + "# Actual skill source\n");
      expect(await readFile(legacy, "utf8")).toBe("USER-OWNED CONTENT");
      expect((await adapter.applyContext(context)).digest).toBe(applied.digest);
      const tombstone = await adapter.cleanup();
      expect(tombstone.digest).toBe(adapter.planCleanup().digest);
      expect(await adapter.readFile(tombstone.digest, "skills/example/SKILL.md")).toBeNull();
      expect(await adapter.readContext(tombstone.digest)).toBeNull();
      expect((await adapter.readFile(applied.digest, "skills/example/SKILL.md"))?.toString())
        .toContain("# Actual skill source");
      expect(await readFile(legacy, "utf8")).toBe("USER-OWNED CONTENT");
    });
  });

  it("publishes Claude generations even if the legacy adapter root is a symlink", async () => {
    await withFixture(async (root, store) => {
      const outside = await mkdtemp(join(tmpdir(), "skillgate-legacy-outside-"));
      try {
        await writeFile(join(outside, "victim"), "USER CONTENT");
        await symlink(outside, join(root, ".claude"), "dir");
        const source = join(root, "source.md");
        await writeFile(source, "# Skill");
        const adapter = new ClaudeCodeAdapter().immutable(store);
        const result = await adapter.applyContext({ root, task: "task", skills: [{
          path: source, metadata: { name: "skill", description: "description" },
          score: 1, reasons: [],
        }] });
        expect((await adapter.readFile(result.digest, "skills/skill/SKILL.md"))?.toString())
          .toContain("# Skill");
        expect(await readFile(join(outside, "victim"), "utf8")).toBe("USER CONTENT");
        expect(await readdir(outside)).toEqual(["victim"]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("fails before publishing when source UTF-8 is invalid", async () => {
    await withFixture(async (root, store) => {
      const source = join(root, "invalid.md");
      await writeFile(source, Buffer.from([0xff, 0xfe]));
      const adapter = new CodexAdapter().immutable(store);
      await expect(adapter.applyContext({ root, task: "task", skills: [{
        path: source, metadata: { name: "bad", description: "bad" },
        score: 0, reasons: [],
      }] })).rejects.toThrow();
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("never mutates legacy paths while an independent process races their entries and parent", async () => {
    if (process.platform === "win32") return;
    await withFixture(async (root, store) => {
      const source = join(root, "stable-source.md");
      await writeFile(source, "# Stable source");
      const outside = await mkdtemp(join(tmpdir(), "skillgate-external-victim-"));
      const victim = join(outside, "victim.md");
      await writeFile(victim, "USER-OWNED VICTIM");
      const legacy = join(root, ".codex");
      const writerScript = [
        "const fs=require('node:fs'),path=require('node:path');",
        "const legacy=process.argv[1],victim=process.argv[2];",
        "let ticks=0;",
        "setInterval(()=>{",
        "try {",
        "fs.rmSync(legacy,{recursive:true,force:true});",
        "const dir=path.join(legacy,'skills','example');",
        "fs.mkdirSync(dir,{recursive:true});",
        "const file=path.join(dir,'SKILL.md');",
        "fs.writeFileSync(file,'EXTERNAL');",
        "fs.rmSync(file);fs.linkSync(victim,file);",
        "fs.rmSync(file);fs.symlinkSync(victim,file);",
        "} catch(e) { process.stderr.write(String(e)+'\\n'); }",
        "if(ticks++===0) process.stdout.write('READY\\n');",
        "},0);",
      ].join("");
      const writer = spawn(process.execPath, ["-e", writerScript, legacy, victim], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("External writer startup timeout")), 3000);
          writer.stdout!.once("data", (chunk: Buffer) => {
            clearTimeout(timer);
            if (chunk.toString().includes("READY")) resolve();
            else reject(new Error("External writer did not signal readiness"));
          });
          writer.once("error", (error) => { clearTimeout(timer); reject(error); });
          writer.once("exit", () => { clearTimeout(timer); reject(new Error("External writer exited early")); });
        });
        const adapter = new CodexAdapter().immutable(store);
        for (let i = 0; i < 12; i++) {
          const context = { root, task: `revision-${i}`, skills: [{
            path: source, metadata: { name: "example", description: "Example" },
            score: 1, reasons: [],
          }] };
          const result = await adapter.applyContext(context);
          expect((await adapter.readFile(result.digest, "skills/example/SKILL.md"))?.toString())
            .toContain("# Stable source");
          await adapter.cleanup();
        }
      } finally {
        writer.kill();
        if (writer.exitCode === null && writer.signalCode === null) {
          await once(writer, "exit");
        }
        expect(await readFile(victim, "utf8")).toBe("USER-OWNED VICTIM");
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("rejects pinned metadata that references missing or unlisted files", async () => {
    await withFixture(async (_root, store) => {
      const adapter = new CodexAdapter().immutable(store);
      const metadata = Buffer.from(JSON.stringify({
        schemaVersion: "1", agent: "codex", task: "test",
        skills: [{ name: "x", identifier: "x", description: "test",
          path: "skills/x/SKILL.md", sourcePath: "source.md", score: 1,
          capabilities: [] }],
      }));
      const missing = await adapter.apply({ "skills.json": metadata });
      await expect(adapter.readContext(missing.digest)).rejects.toThrow(/invalid skill file/);
      const extra = await adapter.apply({
        "skills.json": Buffer.from(JSON.stringify({
          schemaVersion: "1", agent: "codex", task: "test", skills: [],
        })),
        "skills/unused/SKILL.md": Buffer.from("unlisted"),
      });
      await expect(adapter.readContext(extra.digest)).rejects.toThrow(/unreferenced/);
    });
  });


  it("refuses immutable publication when the store is inside the mutable workspace", async () => {
    await withFixture(async (root) => {
      const nestedStore = join(root, "protected-store");
      await mkdir(nestedStore, { mode: 0o700 });
      const source = join(root, "source.md");
      await writeFile(source, "# source");
      const adapter = new CodexAdapter().immutable(nestedStore);
      await expect(adapter.applyContext({ root, task: "task", skills: [{
        path: source, metadata: { name: "test", description: "test" },
        score: 1, reasons: [],
      }] })).rejects.toThrow(/outside the workspace/);
      expect(await readdir(nestedStore)).toEqual([]);
    });
  });


});
