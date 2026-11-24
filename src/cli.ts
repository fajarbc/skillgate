#!/usr/bin/env node

import { cwd } from "node:process";
import { pathToFileURL } from "node:url";
import { resolveConfiguration, sanitizeConfiguration, ConfigurationError } from "./config/index.js";
import { parseArgs } from "node:util";
import { getAdapter, listAdapters } from "./adapters/index.js";
import { detectProject } from "./detection/index.js";
import { discoverSkills } from "./discovery/index.js";
import { formatDoctorReport, runDiagnostics } from "./doctor/index.js";
import { evaluatePolicies, loadPolicy, PolicyError } from "./policy/index.js";
import { rankSkills } from "./ranking/index.js";
import { runJson } from "./cli-json-run.js";
import { createTraceRecord, loadLatestTrace, saveTrace } from "./trace/index.js";

const VERSION = "0.0.0";

function usage(): string {
  return [
    "Usage: skillgate <command> [options]",
    "",
    "Commands:",
    "  scan                  Discover skills and project signals",
    "  recommend <task...>   Rank skills for a task",
    "  trace                 Explain the latest selection",
    "  doctor                Check the local SkillGate setup",
    "  config                Print effective configuration as JSON",
    "",
    "Options:",
    "  --root <path>     Project and skill root (default: current directory)",
    "  --adapter <name>  Apply skills to agent workspace (e.g. codex)",
    "  --config <path>   Explicit configuration file",
    "  --json            Print versioned machine-readable JSON",
    "  --stdin           Read v1 JSON task from stdin (recommend --json only)",
    "  -h, --help        Show help",
    "  -v, --version     Show version",
  ].join("\n");
}

async function scan(root: string, skillRoots: string[]) {
  const [discovered, signals] = await Promise.all([
    discoverSkills({ roots: skillRoots }),
    detectProject({ root }),
  ]);
  return { root, skills: discovered, signals };
}

/** Recognize --json only when parseArgs would treat it as an option. */
function requestsJsonTransport(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "--root" || arg === "--adapter" || arg === "--config") {
      // parseArgs rejects a following option as an ambiguous string value.
      // Do not skip --json in that case: callers still need a structured
      // INVALID_REQUEST response rather than a human-only parse error.
      const next = argv[index + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) index += 1;
      continue;
    }
    // A malformed --json=value still explicitly requests machine transport.
    // Let runJson return one structured INVALID_REQUEST rather than human stderr.
    if (arg === "--json" || arg.startsWith("--json=")) return true;
  }
  return false;
}

export async function run(argv: string[]): Promise<number> {
  if (requestsJsonTransport(argv)) return runJson(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        json: { type: "boolean" },
        root: { type: "string" },
        adapter: { type: "string" },
        config: { type: "string" },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    return 1;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    console.log(usage());
    return 0;
  }

  const command = positionals[0];
  if (!["scan", "recommend", "trace", "doctor", "config"].includes(command ?? "")) {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  const root = values.root ?? cwd();

  if (command === "config") {
    try {
      console.log(JSON.stringify(sanitizeConfiguration(await resolveConfiguration({ root, configFile: values.config })), null, 2));
      return 0;
    } catch (error) {
      console.error(error instanceof ConfigurationError ? error.message : String(error));
      return 1;
    }
  }

  if (command === "doctor") {
    const report = await runDiagnostics({ root });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    return report.status === "fail" ? 1 : 0;
  }

  if (command === "trace") {
    const trace = await loadLatestTrace(root);
    if (!trace) {
      if (values.json) {
        console.log(JSON.stringify({ error: "no trace found" }, null, 2));
      } else {
        console.log("No trace found. Run `skillgate recommend` first.");
      }
      return 0;
    }

    if (values.json) {
      console.log(JSON.stringify(trace, null, 2));
    } else {
      console.log(`Trace: ${trace.id} (${trace.timestamp})`);
      console.log(`Task: ${trace.task}`);
      console.log(`Root: ${trace.root}`);
      console.log(`Signals: ${trace.signals.length}`);
      for (const signal of trace.signals) {
        console.log(`- ${signal.kind}:${signal.name} [${signal.evidence}]`);
      }
      console.log(`Selected (${trace.selectedCount}):`);
      for (const candidate of trace.candidates.filter((c) => c.status === "selected")) {
        console.log(`- ${candidate.name}  score=${candidate.score}  (~${candidate.estimatedTokens} tokens)`);
        for (const reason of candidate.reasons) {
          console.log(`    ${reason.source}:${reason.term} +${reason.points}`);
        }
      }
      console.log(`Rejected (${trace.rejectedCount}):`);
      for (const candidate of trace.candidates.filter((c) => c.status === "rejected")) {
        console.log(`- ${candidate.name}  reason=${candidate.decisionReason}`);
      }
      console.log(`Total context estimate: ~${trace.totalEstimatedTokens} tokens`);
    }
    return 0;
  }

  let configuration;
  try {
    configuration = await resolveConfiguration({ root, configFile: values.config });
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : String(error));
    return 1;
  }

  const state = await scan(root, configuration.skillRoots);

  if (command === "scan") {
    if (values.json) console.log(JSON.stringify(state, null, 2));
    else {
      console.log(`Skills: ${state.skills.length}`);
      for (const skill of state.skills) {
        console.log(skill.metadata ? `- ${skill.metadata.name} (${skill.path})` : `- invalid (${skill.path}): ${skill.error}`);
      }
      console.log(`Signals: ${state.signals.length}`);
      for (const signal of state.signals) console.log(`- ${signal.kind}:${signal.name} [${signal.evidence}]`);
    }
    return 0;
  }

  const task = positionals.slice(1).join(" ").trim();
  if (!task) {
    console.error("recommend requires task text");
    return 1;
  }

  const skills = state.skills.flatMap((skill) =>
    skill.metadata ? [{ path: skill.path, metadata: skill.metadata }] : [],
  );
  let policy;
  try {
    policy = await loadPolicy(root, configuration.policyPath);
  } catch (error) {
    if (error instanceof PolicyError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const policyEvaluations = evaluatePolicies(skills, policy);
  const evalMap = new Map(policyEvaluations.map((e) => [e.skill.path, e]));
  // Filter before candidateLimit so denied high-scoring skills cannot crowd
  // out lower-scoring permitted matches (same behavior as JSON transport).
  const eligibleSkills = policyEvaluations
    .filter((evaluation) => evaluation.decision === "allow")
    .map((evaluation) => evaluation.skill);
  const deniedSkills = policyEvaluations
    .filter((evaluation) => evaluation.decision === "deny")
    .map((evaluation) => evaluation.skill);
  const rankedEligible = rankSkills({
    task, skills: eligibleSkills, signals: state.signals, limit: eligibleSkills.length,
  });
  const approvedRecommendations = rankedEligible.slice(0, configuration.candidateLimit);
  // Preserve relevance evidence for denied skills without letting them consume
  // candidateLimit or appear selected. createTraceRecord rejects them by policy.
  const deniedForTrace = rankSkills({
    task, skills: deniedSkills, signals: state.signals, limit: deniedSkills.length,
  });

  const traceRecord = createTraceRecord({
    task,
    root,
    signals: state.signals,
    discoveredSkills: state.skills,
    rankedSkills: approvedRecommendations,
    scoredSkills: [...rankedEligible, ...deniedForTrace],
    policyEvaluations: evalMap,
  });
  await saveTrace(traceRecord, root);

  let adapterSummary: string | undefined;
  if (values.adapter) {
    if (configuration.adapters.length > 0 && !configuration.adapters.includes(values.adapter)) {
      console.error(`Adapter ${values.adapter} is not enabled in the effective configuration`);
      return 1;
    }
    const adapter = getAdapter(values.adapter);
    if (!adapter) {
      console.error(`Unknown adapter: ${values.adapter}. Available adapters: ${listAdapters().join(", ")}`);
      return 1;
    }
    const result = await adapter.apply({
      task,
      root,
      skills: approvedRecommendations,
      options: configuration.adapterOptions[adapter.name] ?? configuration.adapterOptions[values.adapter],
    });
    adapterSummary = result.summary;
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task,
          recommendations: approvedRecommendations,
          ...(adapterSummary ? { adapter: adapterSummary } : {}),
        },
        null,
        2,
      ),
    );
  } else if (approvedRecommendations.length === 0) {
    console.log("No relevant skills found.");
  } else {
    for (const skill of approvedRecommendations) {
      console.log(`${skill.metadata.name}  score=${skill.score}`);
      for (const reason of skill.reasons) console.log(`  - ${reason.source}:${reason.term} +${reason.points}`);
    }
    if (adapterSummary) {
      console.log(adapterSummary);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
