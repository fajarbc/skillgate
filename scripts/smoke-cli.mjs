import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate as validateCliJson } from "./validate-cli-json-fixtures.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const jsonSchema = JSON.parse(await readFile(join(repository, "schemas", "cli-json-v1.schema.json"), "utf8"));
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

    function invoke(args, expectedStatus = 0, input) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
        input,
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stderr, "", "successful CLI invocations must not print diagnostics");
      assert.notEqual(result.stdout.trim(), "", "CLI entry point must actually run");
      if (args.some((arg) => arg === "--json" || arg.startsWith("--json="))) {
        assert.ok(result.stdout.endsWith("\n"), "JSON transport must terminate with a newline");
        assert.equal(result.stdout.split("\n").length, 2, "JSON transport must emit exactly one line");
        // Validate the actual built CLI output, not just golden fixtures.
        // This covers the supported schema subset; full 2020-12 conformance
        // still requires an independent standards-compliant validator.
        validateCliJson(jsonSchema, JSON.parse(result.stdout));
      }
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
    // JSON recommendations must not create trace state before human-mode apply.
    await assert.rejects(access(join(root, ".skillgate")), { code: "ENOENT" });

    // Exercise the built binary's stdin transport with Unicode and invalid requests.
    const stdinTask = "test TypeScript\nReview 日本語 🚀";
    const stdinRequest = JSON.stringify({
      protocolVersion: 1,
      task: stdinTask,
      context: { paths: ["src/cli.ts"] },
    });
    const stdinEnvelope = JSON.parse(invoke(
      ["recommend", "--json", "--stdin", "--root", root], 0, stdinRequest,
    ));
    assert.equal(stdinEnvelope.protocolVersion, 1);
    assert.equal(stdinEnvelope.command, "recommend");
    assert.equal(stdinEnvelope.ok, true);
    assert.equal(stdinEnvelope.data.task, stdinTask);
    assert.ok(Array.isArray(stdinEnvelope.data.recommendations));

    const invalidVersion = JSON.parse(invoke(
      ["recommend", "--json", "--stdin", "--root", root], 1,
      JSON.stringify({ protocolVersion: 2, task: "test" }),
    ));
    assert.equal(invalidVersion.ok, false);
    assert.equal(invalidVersion.error.code, "UNSUPPORTED_PROTOCOL");

    const malformed = JSON.parse(invoke(
      ["recommend", "--json", "--stdin", "--root", root], 1,
      '{"protocolVersion":1,"task":"unclosed',
    ));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, "INVALID_REQUEST");

    // Validate real process stdin boundaries, not just the isolated reader.
    // Invalid UTF-8 must fail closed without emitting replacement characters.
    const invalidUtf8 = JSON.parse(invoke(
      ["recommend", "--json", "--stdin", "--root", root], 1, Buffer.from([0xff]),
    ));
    assert.equal(invalidUtf8.command, "recommend");
    assert.equal(invalidUtf8.ok, false);
    assert.equal(invalidUtf8.error.code, "INVALID_REQUEST");

    // The one-megabyte limit counts the entire serialized request, not just
    // its task string. Exercise the actual CLI entry point at this boundary.
    const oversizedStdin = JSON.parse(invoke(
      ["recommend", "--json", "--stdin", "--root", root], 1,
      JSON.stringify({ protocolVersion: 1, task: "a".repeat(1024 * 1024) }),
    ));
    assert.equal(oversizedStdin.command, "recommend");
    assert.equal(oversizedStdin.ok, false);
    assert.equal(oversizedStdin.error.code, "INVALID_REQUEST");

    // Exercise the built entry point, not just the in-process run() tests:
    // malformed boolean --json assignments must still use JSON transport.
    for (const flag of ["--json=true", "--json=false", "--json="]) {
      const envelope = JSON.parse(invoke(["scan", flag, "--root", root], 1));
      assert.equal(envelope.protocolVersion, 1);
      assert.equal(envelope.command, null);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "INVALID_REQUEST");
    }

    for (const adapter of ["codex", "claude"]) {
      // Machine-mode apply must fail closed until the #28 safety boundary is accepted.
      const rejected = JSON.parse(invoke(["recommend", "test TypeScript", "--adapter", adapter, "--root", root, "--json"], 3));
      assert.equal(rejected.protocolVersion, 1);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, "ADAPTER_CONFLICT");

      // Strict legacy apply must fail before creating adapter files or traces.
      // JSON transport rejects adapter application independently.
      const humanArgs = ["recommend", "test TypeScript", "--adapter", adapter, "--root", root];
      const failed = spawnSync(process.execPath, [cli, ...humanArgs], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
        timeout: 30_000,
      });
      assert.ifError(failed.error);
      assert.equal(failed.status, 1, "strict legacy apply must fail closed");
      assert.equal(failed.stdout, "", "failed adapter apply must not print recommendations");
      assert.match(failed.stderr, /Strict external-writer lifecycle safety/);
      await assert.rejects(access(join(root, `.${adapter}`)), { code: "ENOENT" });
      await assert.rejects(access(join(root, ".skillgate")), { code: "ENOENT" });
    }

    // Human read-only recommendations still persist the legacy trace; the
    // JSON transport and rejected adapter operations never write it.
    invoke(["recommend", "test TypeScript", "--root", root]);
    const trace = json("trace");
    assert.equal(trace.task, "test TypeScript");
    assert.equal(trace.selectedCount, 1);
    assert.equal(trace.candidates[0].name, "testing");
    const config = json("config");
    assert.equal(config.version, 1);
    assert.deepEqual(config.skillRoots, [root]);

    // Exercise real built CLI policy enforcement, not only in-process tests.
    const policyFile = join(root, ".skillgate", "policy.json");
    await writeFile(policyFile, JSON.stringify({ deniedSkills: ["testing"] }));
    const denied = json("recommend", "test TypeScript");
    assert.deepEqual(denied.recommendations, [], "denied skills must not appear in machine recommendations");

    // Machine config output must redact credentials while preserving safe values
    // and leaving the source configuration file untouched.
    const secret = "smoke-cli-secret-canary";
    const configFile = join(temporary, "explicit-config.json");
    const originalConfig = JSON.stringify({
      version: 1,
      adapterOptions: {
        codex: {
          apiKey: secret,
          endpoint: `https://user:${secret}@example.org/v1`,
          signed: `https://example.org/object?X-Amz-Signature=${secret}`,
          safeEndpoint: "https://example.org/docs?mode=read",
        },
      },
    });
    await writeFile(configFile, originalConfig);
    const sanitized = JSON.parse(invoke(["config", "--json", "--root", root, "--config", configFile]));
    assert.equal(sanitized.ok, true);
    assert.deepEqual(sanitized.data.configuration.adapterOptions.codex, {
      apiKey: "[REDACTED]",
      endpoint: "[REDACTED]",
      signed: "[REDACTED]",
      safeEndpoint: "https://example.org/docs?mode=read",
    });
    assert.ok(!JSON.stringify(sanitized).includes(secret), "machine config must not leak credentials");
    assert.equal(await readFile(configFile, "utf8"), originalConfig);

    // A failed doctor must emit one structured JSON error with a report, never
    // echoing the invalid policy value or writing human diagnostics to stderr.
    const invalidPolicy = JSON.stringify({ defaultAction: secret });
    await writeFile(policyFile, invalidPolicy);
    const failedDoctor = JSON.parse(invoke(["doctor", "--json", "--root", root], 2));
    assert.equal(failedDoctor.ok, false);
    assert.equal(failedDoctor.error.code, "CONFIGURATION_ERROR");
    assert.equal(failedDoctor.data.report.status, "fail");
    assert.ok(!JSON.stringify(failedDoctor).includes(secret), "doctor must not leak policy contents");
    assert.equal(await readFile(policyFile, "utf8"), invalidPolicy);

    console.log(`Built CLI smoke passed (${process.platform}, ${process.version})`);
  } finally {
    await rm(built, { recursive: true, force: true });
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
