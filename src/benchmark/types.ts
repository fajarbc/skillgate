import type { ProjectSignal } from "../detection/index.js";
import type { SkillMetadata } from "../discovery/index.js";

export interface BenchmarkCase {
  id: string;
  name: string;
  task: string;
  signals: ProjectSignal[];
  catalog: Array<{ path: string; metadata: SkillMetadata }>;
  expectedSkills: string[];
  forbiddenSkills?: string[];
  limit?: number;
}

export interface BenchmarkCorpus {
  version: string;
  description: string;
  cases: BenchmarkCase[];
}

export interface CaseBenchmarkResult {
  caseId: string;
  task: string;
  expectedCount: number;
  recalledCount: number;
  recall: number;
  recommendedCount: number;
  irrelevantExposureCount: number;
  irrelevantExposureRate: number;
  estimatedTokens: number;
}

export interface BenchmarkReport {
  version: string;
  caseCount: number;
  overallRecall: number;
  overallIrrelevantExposureRate: number;
  totalEstimatedTokens: number;
  averageTokensPerCase: number;
  results: CaseBenchmarkResult[];
}
