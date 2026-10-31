import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DiscoveredSkill } from "../discovery/index.js";
import type { ProjectSignal } from "../detection/index.js";
import type { RankedSkill } from "../ranking/index.js";
import type { SkillPolicyEvaluation } from "../policy/index.js";
import { estimateTokens } from "./estimate.js";
import { loadBoundedJsonTrace } from "../cli-json-run.js";
import { sanitizeText } from "./sanitize.js";
import type { CandidateTrace, TraceRecord } from "./types.js";

export const TRACE_DIR = ".skillgate";
export const TRACE_FILE = "trace.json";

export interface CreateTraceOptions {
  task: string;
  root: string;
  signals: ProjectSignal[];
  discoveredSkills: DiscoveredSkill[];
  rankedSkills: RankedSkill[];
  policyEvaluations?: Map<string, SkillPolicyEvaluation>;
  limit?: number;
}

export function createTraceRecord(options: CreateTraceOptions): TraceRecord {
  const sanitizedTask = sanitizeText(options.task);
  const rankedMap = new Map(options.rankedSkills.map((s) => [s.path, s]));
  const candidates: CandidateTrace[] = [];

  for (const skill of options.discoveredSkills) {
    if (!skill.metadata) {
      candidates.push({
        path: skill.path,
        name: "invalid",
        description: "",
        status: "rejected",
        decisionReason: `invalid skill: ${skill.error ?? "unknown error"}`,
        score: 0,
        reasons: [],
        estimatedTokens: 0,
      });
      continue;
    }

    const policyEval = options.policyEvaluations?.get(skill.path);
    const ranked = rankedMap.get(skill.path);
    const textForTokens = `${skill.metadata.name}: ${skill.metadata.description}`;
    const tokens = estimateTokens(textForTokens);

    if (policyEval && policyEval.decision === "deny") {
      candidates.push({
        path: skill.path,
        name: skill.metadata.name,
        description: skill.metadata.description,
        status: "rejected",
        decisionReason: `denied by policy: ${policyEval.reason}`,
        score: ranked ? ranked.score : 0,
        reasons: ranked ? ranked.reasons : [],
        estimatedTokens: tokens,
        policyDecision: "deny",
      });
    } else if (ranked) {
      candidates.push({
        path: skill.path,
        name: skill.metadata.name,
        description: skill.metadata.description,
        status: "selected",
        decisionReason: `selected with relevance score ${ranked.score}`,
        score: ranked.score,
        reasons: ranked.reasons,
        estimatedTokens: tokens,
        policyDecision: "allow",
      });
    } else {
      candidates.push({
        path: skill.path,
        name: skill.metadata.name,
        description: skill.metadata.description,
        status: "rejected",
        decisionReason: "zero relevance score",
        score: 0,
        reasons: [],
        estimatedTokens: tokens,
        policyDecision: policyEval?.decision ?? "allow",
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.status !== b.status) return a.status === "selected" ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const selectedCount = candidates.filter((c) => c.status === "selected").length;
  const rejectedCount = candidates.filter((c) => c.status === "rejected").length;
  const totalEstimatedTokens = candidates
    .filter((c) => c.status === "selected")
    .reduce((sum, c) => sum + c.estimatedTokens, 0);

  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    task: sanitizedTask,
    root: options.root,
    signals: options.signals,
    candidates,
    selectedCount,
    rejectedCount,
    totalEstimatedTokens,
  };
}

export async function saveTrace(record: TraceRecord, root: string): Promise<string> {
  const dir = join(root, TRACE_DIR);
  await mkdir(dir, { recursive: true });
  // Reject a pre-existing directory symlink. This is a non-strict trace
  // writer, not a substitute for the protected Option B filesystem backend.
  const directory = await lstat(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Refusing to save trace through a symlinked trace directory");
  }

  const file = join(dir, TRACE_FILE);
  const temporaryFile = join(dir, `.trace-${randomUUID()}.tmp`);
  let published = false;
  try {
    // Never truncate the existing pathname: it could be a symlink (or a
    // hardlink) to an unrelated user-owned file. Publish by replacing the
    // directory entry, rather than following its target.
    const handle = await open(
      temporaryFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, file);
    published = true;
  } finally {
    if (!published) await unlink(temporaryFile).catch(() => {});
  }
  return file;
}

export async function loadLatestTrace(root: string): Promise<TraceRecord | null> {
  // Keep the exported trace API aligned with the descriptor-checked, bounded,
  // schema-sanitizing reader used by both human and JSON CLI transports.
  return await loadBoundedJsonTrace(root) as TraceRecord | null;
}
