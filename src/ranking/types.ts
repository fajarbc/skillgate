import type { SkillMetadata } from "../discovery/index.js";
import type { ProjectSignal } from "../detection/index.js";

export interface RankingInput {
  task: string;
  skills: Array<{ path: string; metadata: SkillMetadata }>;
  signals: ProjectSignal[];
  limit?: number;
}

export interface ScoreReason {
  source: "name" | "description" | "project";
  term: string;
  points: number;
}

export interface RankedSkill {
  path: string;
  metadata: SkillMetadata;
  score: number;
  reasons: ScoreReason[];
}
