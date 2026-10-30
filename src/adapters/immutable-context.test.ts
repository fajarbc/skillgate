import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { CodexAdapter } from "./codex.js";
import { ClaudeCodeAdapter } from "./claude.js";
import { OWNERSHIP_HEADER } from "./filesystem-lifecycle.js";
import { prepareImmutableAdapterContext } from "./immutable-context.js";

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
      const context = { root, task: "task", skills: [{
        path: source, metadata: { name: "test", description: "test" },
        score: 1, reasons: [],
      }] };
      await expect(adapter.planContext(context)).rejects.toThrow(/outside the workspace/);
      await expect(adapter.applyContext(context)).rejects.toThrow(/outside the workspace/);
      expect(await readdir(nestedStore)).toEqual([]);
    });
  });


  it("rejects symlink/.. store aliases that would publish inside the workspace", async () => {
    await withFixture(async (root, outside) => {
      const insideStore = join(root, "safe");
      await mkdir(insideStore, { mode: 0o700 });
      await mkdir(join(outside, "sub"), { mode: 0o700 });
      const outsideStore = join(outside, "safe");
      await mkdir(outsideStore, { mode: 0o700 });
      await symlink(join(outside, "sub"), join(root, "alias"), "dir");
      const source = join(root, "source.md");
      await writeFile(source, "# source");
      // The OS resolves alias/../safe to outside/safe; the immutable blob
      // writer intentionally normalizes to root/safe. Containment must use
      // the writer's canonical path, not the raw pathname's realpath.
      const ambiguousStore = `${root}/alias/../safe`;
      const adapter = new CodexAdapter().immutable(ambiguousStore);
      const context = { root, task: "task", skills: [{
        path: source, metadata: { name: "test", description: "test" },
        score: 1, reasons: [],
      }] };
      await expect(adapter.planContext(context)).rejects.toThrow(/outside the workspace/);
      await expect(adapter.applyContext(context)).rejects.toThrow(/outside the workspace/);
      expect(await readdir(insideStore)).toEqual([]);
      expect(await readdir(outsideStore)).toEqual([]);
    });
  });

  it("rejects unsafe store ownership and ancestry during both context plan and apply", async () => {
    if (process.platform === "win32") return;
    await withFixture(async (root, store) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Source");
      const context = { root, task: "task", skills: [{
        path: source, metadata: { name: "example", description: "Example" },
        score: 1, reasons: [],
      }] };

      // realpath() alone considers this alias outside the workspace, but
      // the immutable writer rejects symlinked store ancestry.
      const alias = join(root, "store-alias");
      await symlink(store, alias, "dir");
      const symlinked = new CodexAdapter().immutable(alias);
      await expect(symlinked.planContext(context)).rejects.toThrow(/ancestry/);
      await expect(symlinked.applyContext(context)).rejects.toThrow(/ancestry/);

      // The preview must not succeed for a directory that apply would reject
      // for exposing its contents to the broker's group.
      await chmod(store, 0o770);
      const weakStore = new CodexAdapter().immutable(store);
      await expect(weakStore.planContext(context)).rejects.toThrow(/private POSIX/);
      await expect(weakStore.applyContext(context)).rejects.toThrow(/private POSIX/);
      await chmod(store, 0o700);

      // A writable non-sticky ancestor allows a non-cooperating writer to
      // substitute the entire store, despite a private leaf directory.
      const parent = await mkdtemp(join(tmpdir(), "skillgate-untrusted-store-parent-"));
      try {
        const nested = join(parent, "private");
        await mkdir(nested, { mode: 0o700 });
        await chmod(parent, 0o777);
        const unsafeAncestor = new CodexAdapter().immutable(nested);
        await expect(unsafeAncestor.planContext(context)).rejects.toThrow(/writable.*ancestor/);
        await expect(unsafeAncestor.applyContext(context)).rejects.toThrow(/writable.*ancestor/);
        expect(await readdir(nested)).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }

      // The same valid external store still permits a read-only preview.
      await expect(new CodexAdapter().immutable(store).planContext(context)).resolves.toHaveProperty("digest");
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("rejects invalid runtime metadata before any immutable blob is published", async () => {
    await withFixture(async (root, store) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Skill");
      const adapter = new CodexAdapter().immutable(store);
      const skill = {
        path: source,
        metadata: { name: "example", description: "Example", capabilities: [] as string[] },
        score: Number.NaN, reasons: [],
      };
      const context = { root, task: "task", skills: [skill] };
      await expect(adapter.applyContext(context)).rejects.toThrow(/metadata/);
      expect(await readdir(store)).toEqual([]);
      skill.score = 1;
      skill.metadata.capabilities = [7] as unknown as string[];
      await expect(adapter.planContext(context)).rejects.toThrow(/metadata/);
      await expect(adapter.applyContext(context)).rejects.toThrow(/metadata/);
      expect(await readdir(store)).toEqual([]);
    });
  });



  it("rejects sparse capability arrays before publishing any immutable blob", async () => {
    await withFixture(async (root, store) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Skill");
      const capabilities = new Array<string>(1);
      const context = { root, task: "task", skills: [{
        path: source, metadata: { name: "example", description: "Example", capabilities },
        score: 1, reasons: [],
      }] };
      const adapter = new CodexAdapter().immutable(store);
      await expect(adapter.planContext(context)).rejects.toThrow(/metadata/);
      await expect(adapter.applyContext(context)).rejects.toThrow(/metadata/);
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("snapshots later skills before awaiting the first skill source", async () => {
    await withFixture(async (root) => {
      const first = join(root, "first.md");
      const second = join(root, "second.md");
      await writeFile(first, "# First");
      await writeFile(second, "# Second");
      const later = {
        path: second,
        metadata: { name: "second", description: "Original", capabilities: ["safe"] },
        score: 2, reasons: [],
      };
      const context = { root, task: "task", skills: [{
        path: first, metadata: { name: "first", description: "First" },
        score: 1, reasons: [],
      }, later] };
      const pending = prepareImmutableAdapterContext("codex", context);
      // The first source lstat has yielded. The second skill must already
      // be snapshotted, not re-read after that first asynchronous operation.
      queueMicrotask(() => {
        later.path = join(root, "attacker-missing.md");
        later.metadata.name = "forged";
        later.metadata.description = "Changed";
        later.metadata.capabilities[0] = "bad" + String.fromCharCode(0xd800);
        later.score = Number.NaN;
      });
      const files = await pending;
      const manifest = JSON.parse(files["skills.json"]!.toString("utf8"));
      expect(manifest.skills.map((skill: { name: string }) => skill.name))
        .toEqual(["first", "second"]);
      expect(manifest.skills[1]).toEqual({
        name: "second", identifier: "second", description: "Original",
        path: "skills/second/SKILL.md", sourcePath: second,
        score: 2, capabilities: ["safe"],
      });
      expect(files["skills/second/SKILL.md"]?.toString())
        .toBe(OWNERSHIP_HEADER + "# Second");
    });
  });

  it("snapshots task and skill metadata before asynchronous source reads", async () => {
    await withFixture(async (root) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Skill");
      const skill = {
        path: source,
        metadata: { name: "example", description: "Original", capabilities: ["safe"] },
        score: 1, reasons: [],
      };
      const context = { root, task: "original task", skills: [skill] };
      // Preparation reaches an awaited source lstat before this microtask.
      // The published metadata must describe the original validated snapshot.
      const pending = prepareImmutableAdapterContext("codex", context);
      queueMicrotask(() => {
        context.task = "changed task";
        skill.path = join(root, "missing.md");
        skill.metadata.name = "changed";
        skill.metadata.description = "changed";
        skill.metadata.capabilities[0] = "bad" + String.fromCharCode(0xd800);
        skill.score = Number.NaN;
      });
      const files = await pending;
      const metadata = JSON.parse(files["skills.json"]!.toString("utf8"));
      expect(metadata.task).toBe("original task");
      expect(metadata.skills).toEqual([{
        name: "example", identifier: "example", description: "Original",
        path: "skills/example/SKILL.md", sourcePath: source,
        score: 1, capabilities: ["safe"],
      }]);
      expect(files["skills/example/SKILL.md"]?.toString()).toBe(
        OWNERSHIP_HEADER + "# Skill",
      );
    });
  });

  it("rejects pinned skill bytes missing the ownership header or containing invalid UTF-8", async () => {
    await withFixture(async (_root, store) => {
      const adapter = new CodexAdapter().immutable(store);
      const metadata = Buffer.from(JSON.stringify({
        schemaVersion: "1", agent: "codex", task: "task",
        skills: [{ name: "example", identifier: "example",
          description: "description", path: "skills/example/SKILL.md",
          sourcePath: "source.md", score: 1, capabilities: [] }],
      }));
      for (const content of [
        Buffer.from("# User-owned content"),
        Buffer.concat([Buffer.from(OWNERSHIP_HEADER), Buffer.from([0xff])]),
      ]) {
        const published = await adapter.apply({
          "skills.json": metadata,
          "skills/example/SKILL.md": content,
        });
        await expect(adapter.readContext(published.digest))
          .rejects.toThrow(/Invalid immutable adapter skill content/);
      }
      const valid = await adapter.apply({
        "skills.json": metadata,
        "skills/example/SKILL.md": Buffer.from(OWNERSHIP_HEADER + "# Valid skill\n"),
      });
      expect((await adapter.readContext(valid.digest))?.skills[0]?.identifier).toBe("example");
    });
  });

  it("rejects forged pinned skill identifiers even when their blobs are valid", async () => {
    await withFixture(async (_root, store) => {
      const adapter = new CodexAdapter().immutable(store);
      const forged = await adapter.apply({
        "skills.json": Buffer.from(JSON.stringify({
          schemaVersion: "1", agent: "codex", task: "task",
          skills: [{ name: "Expected Name", identifier: "different-name",
            description: "description", path: "skills/different-name/SKILL.md",
            sourcePath: "source.md", score: 1, capabilities: [] }],
        })),
        "skills/different-name/SKILL.md": Buffer.from("# Forged"),
      });
      await expect(adapter.readContext(forged.digest)).rejects.toThrow(/invalid skill file/);
    });
  });



  it("rejects lone Unicode surrogates before publishing any real-context blob", async () => {
    await withFixture(async (root, store) => {
      const source = join(root, "source.md");
      await writeFile(source, "# Skill");
      const adapter = new CodexAdapter().immutable(store);
      const skill = {
        path: source,
        metadata: { name: "example", description: "good", capabilities: ["valid"] },
        score: 1, reasons: [],
      };
      const context = { root, task: "broken\ud800", skills: [skill] };
      await expect(adapter.planContext(context)).rejects.toThrow(/task/);
      await expect(adapter.applyContext(context)).rejects.toThrow(/task/);
      context.task = "valid";
      skill.metadata.description = "bad\udc00";
      await expect(adapter.applyContext(context)).rejects.toThrow(/metadata/);
      skill.metadata.description = "good";
      skill.metadata.capabilities = ["bad\ud800"];
      await expect(adapter.applyContext(context)).rejects.toThrow(/metadata/);
      expect(await readdir(store)).toEqual([]);
    });
  });

  it("rejects authenticated pinned metadata with escaped lone surrogates", async () => {
    await withFixture(async (_root, store) => {
      const adapter = new CodexAdapter().immutable(store);
      const metadata = (task: string, description: string) => Buffer.from(JSON.stringify({
        schemaVersion: "1", agent: "codex", task,
        skills: [{ name: "example", identifier: "example", description,
          path: "skills/example/SKILL.md", sourcePath: "source.md", score: 1,
          capabilities: ["safe"] }],
      }));
      const skillFile = Buffer.from("# Skill");
      for (const bytes of [metadata("bad\ud800", "valid"), metadata("valid", "bad\udc00")]) {
        const forged = await adapter.apply({
          "skills.json": bytes, "skills/example/SKILL.md": skillFile,
        });
        await expect(adapter.readContext(forged.digest)).rejects.toThrow(/metadata/);
      }
    });
  });

});
