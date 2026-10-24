import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "skillgate-cli-smoke-"));

try {
  // URL-sensitive characters catch entry-point checks based on raw file:// paths.
  // Keep the copied CLI under the repository so its normal dependencies resolve.
  const built = await mkdtemp(join(repository, ".cli-smoke # % ü-"));
  try {
    await cp(join(repository, "dist"), built, { recursive: true });
    const cli = join(built, "cli.js");
    const root = join(temporary, "workspace with spaces ü");
    const home = join(temporary, "home");
    await mkdir(home);
    await mkdir(join(root, "skills", "testing"), { recursive: true });
    await writeFile(join(root, "skills", "testing", "SKILL.md"),
      "---\nname: testing\ndescription: Test TypeScript code\n---\n# Run tests\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "5.7.0" } }));

    function invoke(args, expectedStatus = 0) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stderr, "", "successful CLI invocations must not print diagnostics");
      assert.notEqual(result.stdout.trim(), "", "CLI entry point must actually run");
      return result.stdout;
    }

    function json(command, ...args) {
      const envelope = JSON.parse(invoke([command, ...args, "--root", root, "--json"]));
      assert.equal(envelope.protocolVersion, 1);
      assert.equal(envelope.command, command);
      assert.equal(envelope.ok, true);
      if (command === "doctor") return envelope.data.report;
      if (command === "trace") return envelope.data.trace;
      if (command === "config") return envelope.data.configuration;
      return envelope.data;
    }

    assert.equal(invoke(["--version"]).trim(), pkg.version);
    const scan = json("scan");
    assert.deepEqual(Object.keys(scan).sort(), ["root", "signals", "skills"]);
    assert.equal(scan.root, root); // Paths intentionally use the host's native separators.
    assert.equal(scan.skills[0].path, join(root, "skills", "testing", "SKILL.md"));
    assert.equal(scan.skills[0].metadata.name, "testing");
    assert.ok(scan.signals.some((signal) => signal.name === "typescript"));

    const doctor = json("doctor");
    assert.equal(doctor.status, "ok");
    assert.equal(doctor.root, root);
    assert.equal(doctor.version, pkg.version);
    assert.equal(doctor.summary.failures, 0);

    const recommendation = json("recommend", "test TypeScript");
    assert.deepEqual(Object.keys(recommendation).sort(), ["recommendations", "task"]);
    assert.equal(recommendation.task, "test TypeScript");
    assert.equal(recommendation.recommendations[0].metadata.name, "testing");

    for (const adapter of ["codex", "claude"]) {
      // Machine-mode apply must fail closed until the #28 safety boundary is accepted.
      const rejected = JSON.parse(invoke(["recommend", "test TypeScript", "--adapter", adapter, "--root", root, "--json"], 3));
      assert.equal(rejected.protocolVersion, 1);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "ADAPTER_CONFLICT");

      // Human CLI adapter behavior remains backward-compatible.
      const humanArgs = ["recommend", "test TypeScript", "--adapter", adapter, "--root", root];
      assert.match(invoke(humanArgs), /testing/);
      const exposed = join(root, `.${adapter}`, "skills", "testing", "SKILL.md");
      const managed = await readFile(exposed, "utf8");
      assert.match(managed, /# Run tests/);
      // Reapplying an unchanged skill must preserve its managed content.
      invoke(humanArgs);
      assert.equal(await readFile(exposed, "utf8"), managed);
    }

    const trace = json("trace");
    assert.equal(trace.task, "test TypeScript");
    assert.equal(trace.selectedCount, 1);
    assert.equal(trace.candidates[0].name, "testing");
    const config = json("config");
    assert.equal(config.version, 1);
    assert.deepEqual(config.skillRoots, [root]);

    console.log(`Built CLI smoke passed (${process.platform}, ${process.version})`);
  } finally {
    await rm(built, { recursive: true, force: true });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
