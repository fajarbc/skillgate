#!/usr/bin/env node

import { parseArgs } from "node:util";

const VERSION = "0.0.0";

function usage(): string {
  return [
    "Usage: skillgate <command>",
    "",
    "Commands:",
    "  scan       Discover skills and project signals",
    "  recommend  Rank skills for a task",
    "  trace      Explain the latest selection",
    "  doctor     Check the local SkillGate setup",
    "",
    "Options:",
    "  -h, --help     Show help",
    "  -v, --version  Show version",
  ].join("\n");
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

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

  console.log(`${command}: not implemented yet`);
  return 0;
}

process.exitCode = run(process.argv.slice(2));
