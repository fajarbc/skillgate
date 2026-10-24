import { cwd, stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { resolveConfiguration, sanitizeConfiguration, ConfigurationError } from "./config/index.js";
import { detectProject } from "./detection/index.js";
import { discoverSkills } from "./discovery/index.js";
import { runDiagnostics } from "./doctor/index.js";
import { evaluatePolicies, loadPolicy, PolicyError } from "./policy/index.js";
import { rankSkills } from "./ranking/index.js";
import { createTraceRecord, loadLatestTrace, saveTrace } from "./trace/index.js";
import { jsonFailure, jsonLine, jsonSuccess, type JsonProtocolCommand, type JsonProtocolErrorCode } from "./cli-json-protocol.js";
import { JsonStdinRequestError, readJsonStdinRequest } from "./cli-json-stdin.js";

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
      return succeed(selected, { trace: await loadLatestTrace(root) });
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

    const traceRecord = createTraceRecord({
      task: task!,
      root,
      signals,
      discoveredSkills: skillsFound,
      rankedSkills: approvedRecommendations,
      policyEvaluations: evalMap,
    });
    await saveTrace(traceRecord, root);
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
