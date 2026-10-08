import { access, constants, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listAdapters } from "../adapters/index.js";
import { discoverSkills } from "../discovery/index.js";
import { loadPolicy, PolicyError } from "../policy/index.js";
import type { DiagnosticCheck, DiagnosticStatus, DoctorReport } from "./types.js";

const VERSION = "0.0.0";

export interface DoctorOptions {
  root: string;
  nodeVersion?: string;
}

export async function runDiagnostics(options: DoctorOptions): Promise<DoctorReport> {
  const root = options.root;
  const nodeVer = options.nodeVersion ?? process.version;
  const checks: DiagnosticCheck[] = [];

  const major = parseInt(nodeVer.replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (major >= 20) {
    checks.push({
      name: "node-runtime",
      status: "ok",
      message: `Node.js ${nodeVer} satisfies supported engine requirement (>=20)`,
    });
  } else {
    checks.push({
      name: "node-runtime",
      status: "fail",
      message: `Node.js ${nodeVer} is unsupported. SkillGate requires Node.js >=20`,
    });
  }

  try {
    await access(root, constants.R_OK | constants.W_OK);
    const managedDir = join(root, ".skillgate");
    await mkdir(managedDir, { recursive: true });
    const probeFile = join(managedDir, ".write-probe");
    await writeFile(probeFile, "probe", "utf8");
    await rm(probeFile, { force: true });

    checks.push({
      name: "filesystem-permissions",
      status: "ok",
      message: "Project root and .skillgate/ managed directory are writable",
    });
  } catch (err: unknown) {
    checks.push({
      name: "filesystem-permissions",
      status: "fail",
      message: `Write permission error: ${(err as Error).message}`,
    });
  }

  try {
    const policy = await loadPolicy(root);
    checks.push({
      name: "policy-configuration",
      status: "ok",
      message: `Policy configuration valid (defaultAction: ${policy.defaultAction})`,
    });
  } catch (err: unknown) {
    if (err instanceof PolicyError) {
      checks.push({
        name: "policy-configuration",
        status: "fail",
        message: err.message,
      });
    } else {
      checks.push({
        name: "policy-configuration",
        status: "fail",
        message: `Unexpected policy error: ${(err as Error).message}`,
      });
    }
  }

  try {
    const discovered = await discoverSkills({ roots: [root] });
    const valid = discovered.filter((s) => s.metadata !== undefined);
    const invalid = discovered.filter((s) => s.error !== undefined);

    if (invalid.length > 0) {
      checks.push({
        name: "skill-discovery",
        status: "warn",
        message: `Found ${valid.length} valid skill(s) and ${invalid.length} invalid skill(s)`,
        detail: {
          invalidSkills: invalid.map((s) => ({ path: s.path, error: s.error })),
        },
      });
    } else {
      checks.push({
        name: "skill-discovery",
        status: "ok",
        message: `Discovered ${valid.length} valid skill(s)`,
      });
    }
  } catch (err: unknown) {
    checks.push({
      name: "skill-discovery",
      status: "warn",
      message: `Skill discovery error: ${(err as Error).message}`,
    });
  }

  const adapters = listAdapters();
  checks.push({
    name: "adapters",
    status: "ok",
    message: `Available adapters: ${adapters.join(", ")}`,
  });

  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const passed = checks.filter((c) => c.status === "ok").length;

  let overallStatus: DiagnosticStatus = "ok";
  if (failures > 0) {
    overallStatus = "fail";
  } else if (warnings > 0) {
    overallStatus = "warn";
  }

  return {
    timestamp: new Date().toISOString(),
    status: overallStatus,
    version: VERSION,
    nodeVersion: nodeVer,
    root,
    checks,
    summary: {
      total: checks.length,
      passed,
      warnings,
      failures,
    },
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const symbol = {
    ok: "✓",
    warn: "!",
    fail: "✗",
  };

  const lines: string[] = [
    `SkillGate Doctor (v${report.version})`,
    `Root: ${report.root}`,
    `Status: ${report.status.toUpperCase()}`,
    "",
    "Checks:",
  ];

  for (const check of report.checks) {
    lines.push(`  [${symbol[check.status]}] ${check.name}: ${check.message}`);
  }

  lines.push("");
  lines.push(
    `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warning(s), ${report.summary.failures} failure(s)`,
  );

  return lines.join("\n");
}
