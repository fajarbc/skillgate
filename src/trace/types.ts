import type { ProjectSignal } from "../detection/index.js";
import type { ScoreReason } from "../ranking/index.js";

export type CandidateStatus = "selected" | "rejected";

export interface CandidateTrace {
  path: string;
  name: string;
  description: string;
  status: CandidateStatus;
  decisionReason: string;
  score: number;
  reasons: ScoreReason[];
  estimatedTokens: number;
}

export interface TraceRecord {
  id: string;
  timestamp: string;
  task: string;
  root: string;
  signals: ProjectSignal[];
  candidates: CandidateTrace[];
  selectedCount: number;
  rejectedCount: number;
  totalEstimatedTokens: number;
}
