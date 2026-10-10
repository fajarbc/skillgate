#!/usr/bin/env node

import { cwd } from "node:process";
import { resolveConfiguration, ConfigurationError } from "./config/index.js";
import { parseArgs } from "node:util";
import { getAdapter, listAdapters } from "./adapters/index.js";
import { detectProject } from "./detection/index.js";
import { discoverSkills } from "./discovery/index.js";
import { formatDoctorReport, runDiagnostics } from "./doctor/index.js";
import { evaluatePolicies, loadPolicy, PolicyError } from "./policy/index.js";
import { rankSkills } from "./ranking/index.js";
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
    "  --json            Print machine-readable JSON",
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

export async function run(argv: string[]): Promise<number> {
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
      console.log(JSON.stringify(await resolveConfiguration({ root, configFile: values.config }), null, 2));
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
  const recommendations = rankSkills({ task, skills, signals: state.signals, limit: configuration.candidateLimit });

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

  const approvedRecommendations = recommendations.filter((rec) => {
    const evaluation = evalMap.get(rec.path);
    return evaluation ? evaluation.decision === "allow" : true;
  });

  const traceRecord = createTraceRecord({
    task,
    root,
    signals: state.signals,
    discoveredSkills: state.skills,
    rankedSkills: approvedRecommendations,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
