import { rankSkills } from "../ranking/index.js";
import { estimateTokens } from "../trace/index.js";
import { CORPUS_V1 } from "./fixtures/v1.js";
import type { BenchmarkCorpus, BenchmarkReport, CaseBenchmarkResult } from "./types.js";

export function runBenchmark(corpus: BenchmarkCorpus = CORPUS_V1): BenchmarkReport {
  const results: CaseBenchmarkResult[] = [];
  let totalRecallNumerator = 0;
  let totalRecallDenominator = 0;
  let totalIrrelevantExposure = 0;
  let totalRecommended = 0;
  let totalEstimatedTokens = 0;

  for (const c of corpus.cases) {
    const recommendations = rankSkills({
      task: c.task,
      signals: c.signals,
      skills: c.catalog,
      limit: c.limit,
    });

    const recommendedNames = new Set(recommendations.map((r) => r.metadata.name));
    const recalledCount = c.expectedSkills.filter((name) => recommendedNames.has(name)).length;
    const expectedCount = c.expectedSkills.length;
    const recall = expectedCount > 0 ? recalledCount / expectedCount : 1.0;

    let irrelevantCount = 0;
    if (c.forbiddenSkills && c.forbiddenSkills.length > 0) {
      irrelevantCount = c.forbiddenSkills.filter((name) => recommendedNames.has(name)).length;
    } else {
      irrelevantCount = recommendations.filter((r) => !c.expectedSkills.includes(r.metadata.name)).length;
    }

    const recommendedCount = recommendations.length;
    const irrelevantExposureRate = recommendedCount > 0 ? irrelevantCount / recommendedCount : 0;

    const caseTokens = recommendations.reduce((sum, r) => {
      const text = `${r.metadata.name}: ${r.metadata.description}`;
      return sum + estimateTokens(text);
    }, 0);

    totalRecallNumerator += recalledCount;
    totalRecallDenominator += expectedCount;
    totalIrrelevantExposure += irrelevantCount;
    totalRecommended += recommendedCount;
    totalEstimatedTokens += caseTokens;

    results.push({
      caseId: c.id,
      task: c.task,
      expectedCount,
      recalledCount,
      recall,
      recommendedCount,
      irrelevantExposureCount: irrelevantCount,
      irrelevantExposureRate,
      estimatedTokens: caseTokens,
    });
  }

  const overallRecall = totalRecallDenominator > 0 ? totalRecallNumerator / totalRecallDenominator : 1.0;
  const overallIrrelevantExposureRate = totalRecommended > 0 ? totalIrrelevantExposure / totalRecommended : 0;
  const averageTokensPerCase = corpus.cases.length > 0 ? Math.round(totalEstimatedTokens / corpus.cases.length) : 0;

  return {
    version: corpus.version,
    caseCount: corpus.cases.length,
    overallRecall,
    overallIrrelevantExposureRate,
    totalEstimatedTokens,
    averageTokensPerCase,
    results,
  };
}
