#!/usr/bin/env node

import { cwd } from "node:process";
import { parseArgs } from "node:util";
import { detectProject } from "./detection/index.js";
import { discoverSkills } from "./discovery/index.js";
import { evaluatePolicies, loadPolicy } from "./policy/index.js";
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
    "",
    "Options:",
    "  --root <path>   Project and skill root (default: current directory)",
    "  --json          Print machine-readable JSON",
    "  -h, --help      Show help",
    "  -v, --version   Show version",
  ].join("\n");
}

async function scan(root: string) {
  const [discovered, signals] = await Promise.all([
    discoverSkills({ roots: [root] }),
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
  if (!["scan", "recommend", "trace", "doctor"].includes(command ?? "")) {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  if (command === "doctor") {
    console.log(`${command}: not implemented yet`);
    return 0;
  }

  const root = values.root ?? cwd();

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

  const state = await scan(root);

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
  const recommendations = rankSkills({ task, skills, signals: state.signals });

  const policy = await loadPolicy(root);
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

  if (values.json) console.log(JSON.stringify({ task, recommendations: approvedRecommendations }, null, 2));
  else if (approvedRecommendations.length === 0) console.log("No relevant skills found.");
  else {
    for (const skill of approvedRecommendations) {
      console.log(`${skill.metadata.name}  score=${skill.score}`);
      for (const reason of skill.reasons) console.log(`  - ${reason.source}:${reason.term} +${reason.points}`);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
