import { describe, expect, it } from "vitest";
import { CORPUS_V1, runBenchmark } from "./index.js";

describe("Benchmark", () => {
  it("runs corpus deterministically and measures routing metrics", () => {
    const report = runBenchmark(CORPUS_V1);

    expect(report.caseCount).toBe(4);
    expect(report.overallRecall).toBe(1.0);
    expect(report.overallIrrelevantExposureRate).toBe(0.0);
    expect(report.totalEstimatedTokens).toBeGreaterThan(0);
    expect(report.averageTokensPerCase).toBeGreaterThan(0);

    for (const result of report.results) {
      expect(result.recall).toBe(1.0);
      expect(result.irrelevantExposureCount).toBe(0);
      expect(result.estimatedTokens).toBeGreaterThan(0);
    }
  });

  it("produces identical results across runs", () => {
    const run1 = runBenchmark(CORPUS_V1);
    const run2 = runBenchmark(CORPUS_V1);

    expect(run1).toEqual(run2);
  });
});
