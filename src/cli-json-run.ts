import { cwd, stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { resolveConfiguration, sanitizeConfiguration, ConfigurationError } from "./config/index.js";
import { detectProject } from "./detection/index.js";
import { discoverSkills } from "./discovery/index.js";
import { runDiagnostics } from "./doctor/index.js";
import { evaluatePolicies, loadPolicy, PolicyError } from "./policy/index.js";
import { rankSkills } from "./ranking/index.js";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { jsonFailure, jsonLine, jsonSuccess, type JsonProtocolCommand, type JsonProtocolErrorCode } from "./cli-json-protocol.js";
import { JsonStdinRequestError, readJsonStdinRequest } from "./cli-json-stdin.js";

/** Read existing trace data without following a user-controlled trace symlink or FIFO.
 * A stable descriptor and bounded read prevent machine callers from hanging
 * on special files or emitting arbitrary JSON through a symlinked trace.
 * This is a read-only defense, not an atomic guarantee against external writers.
 */
async function loadBoundedJsonTrace(root: string): Promise<unknown | null> {
  const directory = join(root, ".skillgate");
  const file = join(directory, "trace.json");
  const maxBytes = 32 * 1024 * 1024;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null;
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
        entry.size > maxBytes) return null;
    handle = await open(file, constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes ||
        before.dev !== entry.dev || before.ino !== entry.ino ||
        before.size !== entry.size || before.mtimeMs !== entry.mtimeMs ||
        before.ctimeMs !== entry.ctimeMs) return null;
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    // Reject a source that grows after the initial size check.
    if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, null)).bytesRead !== 0) return null;
    const after = await handle.stat();
    const current = await lstat(file);
    const parentAfter = await lstat(directory);
    if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() ||
        parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino ||
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs || after.nlink !== 1 ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    // Missing, malformed, or unsafe traces are reported as absent.
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The JSON transport deliberately has one stdout write per invocation.
 * Human-facing CLI output remains in cli.ts and is not changed by this module.
 */
export async function runJson(
  argv: string[],
  input: AsyncIterable<Uint8Array | string> = stdin,
): Promise<number> {
  let command: string | null = null;
  const fail = (code: JsonProtocolErrorCode, message: string, exitCode = 1): number => {
    stdout.write(jsonLine(jsonFailure(command, code, message)));
    return exitCode;
  };
  const succeed = (name: JsonProtocolCommand, data: unknown): number => {
    stdout.write(jsonLine(jsonSuccess(name, data)));
    return 0;
  };

  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          json: { type: "boolean" },
          stdin: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
          root: { type: "string" },
          adapter: { type: "string" },
          config: { type: "string" },
        },
      });
    } catch {
      return fail("INVALID_REQUEST", "Invalid command-line arguments");
    }

    const { values, positionals } = parsed;
    command = positionals[0] ?? null;
    const supported: readonly string[] = ["scan", "recommend", "trace", "doctor", "config"];
    if (!values.json || values.help || values.version || !command || !supported.includes(command)) {
      return fail("INVALID_REQUEST", "A supported command with --json is required");
    }
    const selected = command as JsonProtocolCommand;
    if (values.stdin && (selected !== "recommend" || positionals.length !== 1)) {
      return fail("INVALID_REQUEST", "--stdin requires recommend without positional task text");
    }
    if (selected !== "recommend" && positionals.length !== 1) {
      return fail("INVALID_REQUEST", "Unexpected positional arguments");
    }
    if (values.adapter !== undefined && selected !== "recommend") {
      return fail("INVALID_REQUEST", "--adapter is only supported with recommend");
    }
    if (values.adapter !== undefined) {
      // This is an apply operation, not a read-only recommendation. Do not
      // expose it to machine callers before #28 lifecycle safety is accepted.
      return fail("ADAPTER_CONFLICT", "JSON adapter application is unavailable pending lifecycle safety validation", 3);
    }

    let task: string | undefined;
    if (selected === "recommend") {
      if (values.stdin) {
        task = (await readJsonStdinRequest(input)).task;
      } else {
        task = positionals.slice(1).join(" ").trim();
      }
      if (!task?.trim()) {
        return fail("INVALID_REQUEST", "recommend requires nonempty task text");
      }
    }

    const root = values.root ?? cwd();
    if (selected === "trace") {
      return succeed(selected, { trace: await loadBoundedJsonTrace(root) });
    }
    if (selected === "doctor") {
      const report = await runDiagnostics({ root });
      if (report.status === "fail") {
        // Retain diagnostic details while returning a structured nonzero result.
        stdout.write(jsonLine({
          ...jsonFailure(selected, "CONFIGURATION_ERROR", "Doctor checks failed"),
          data: { report },
        }));
        return 2;
      }
      return succeed(selected, { report });
    }

    const configuration = await resolveConfiguration({ root, configFile: values.config });
    if (selected === "config") {
      return succeed(selected, { configuration: sanitizeConfiguration(configuration) });
    }

    const [skillsFound, signals] = await Promise.all([
      discoverSkills({ roots: configuration.skillRoots }),
      detectProject({ root }),
    ]);
    if (selected === "scan") {
      return succeed(selected, { root, skills: skillsFound, signals });
    }

    // The remaining supported command is recommend.
    const skills = skillsFound.flatMap((skill) =>
      skill.metadata ? [{ path: skill.path, metadata: skill.metadata }] : [],
    );
    const recommendations = rankSkills({
      task: task!,
      skills,
      signals,
      limit: configuration.candidateLimit,
    });
    const policy = await loadPolicy(root, configuration.policyPath);
    const policyEvaluations = evaluatePolicies(skills, policy);
    const evalMap = new Map(policyEvaluations.map((evaluation) => [evaluation.skill.path, evaluation]));
    const approvedRecommendations = recommendations.filter((recommendation) => {
      const evaluation = evalMap.get(recommendation.path);
      return evaluation ? evaluation.decision === "allow" : true;
    });

    // JSON recommendations must remain read-only until #28 defines an accepted
    // lifecycle for managed writes. saveTrace() writes to a predictable path
    // and can follow an existing symlink, overwriting user-owned content.
    // The trace command still reads traces created by the human CLI.
    return succeed(selected, {
      task: task!,
      recommendations: approvedRecommendations,
    });
  } catch (error) {
    if (error instanceof JsonStdinRequestError) {
      return fail(error.code, error.message);
    }
    if (error instanceof ConfigurationError) {
      return fail("CONFIGURATION_ERROR", "Unable to resolve configuration", 2);
    }
    if (error instanceof PolicyError) {
      return fail("POLICY_ERROR", "Unable to load policy", 2);
    }
    return fail("INTERNAL_ERROR", "Unexpected CLI error", 4);
  }
}
