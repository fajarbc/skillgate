import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DiscoveredSkill } from "../discovery/index.js";
import type { ProjectSignal } from "../detection/index.js";
import type { RankedSkill } from "../ranking/index.js";
import { estimateTokens } from "./estimate.js";
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

    const ranked = rankedMap.get(skill.path);
    const textForTokens = `${skill.metadata.name}: ${skill.metadata.description}`;
    const tokens = estimateTokens(textForTokens);

    if (ranked) {
      candidates.push({
        path: skill.path,
        name: skill.metadata.name,
        description: skill.metadata.description,
        status: "selected",
        decisionReason: `selected with relevance score ${ranked.score}`,
        score: ranked.score,
        reasons: ranked.reasons,
        estimatedTokens: tokens,
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
  const file = join(dir, TRACE_FILE);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}

export async function loadLatestTrace(root: string): Promise<TraceRecord | null> {
  const file = join(root, TRACE_DIR, TRACE_FILE);
  try {
    const content = await readFile(file, "utf8");
    return JSON.parse(content) as TraceRecord;
  } catch {
    return null;
  }
}
