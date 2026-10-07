import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTraceRecord, estimateTokens, loadLatestTrace, saveTrace } from "./index.js";
import { sanitizeText } from "./sanitize.js";

describe("trace", () => {
  it("estimates token counts from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a quick brown fox")).toBe(5);
  });

  it("sanitizes obvious secrets from text", () => {
    expect(sanitizeText("api_key: secret123")).toContain("[REDACTED]");
    expect(sanitizeText("Bearer eyJhbGciOi...12345")).toBe("Bearer [REDACTED]");
    expect(sanitizeText("ghp_123456789012345678901234567890")).toBe("[REDACTED_GH_TOKEN]");
    expect(sanitizeText("normal task text")).toBe("normal task text");
  });

  it("creates trace record with selected and rejected candidates", () => {
    const record = createTraceRecord({
      task: "react testing",
      root: "/app",
      signals: [{ kind: "framework", name: "react", evidence: "package.json" }],
      discoveredSkills: [
        {
          path: "/skills/react/SKILL.md",
          metadata: { name: "react-testing", description: "Test React components" },
        },
        {
          path: "/skills/docker/SKILL.md",
          metadata: { name: "docker", description: "Manage docker containers" },
        },
        {
          path: "/skills/bad/SKILL.md",
          error: "missing frontmatter",
        },
      ],
      rankedSkills: [
        {
          path: "/skills/react/SKILL.md",
          metadata: { name: "react-testing", description: "Test React components" },
          score: 8,
          reasons: [{ source: "name", term: "react", points: 5 }],
        },
      ],
    });

    expect(record.selectedCount).toBe(1);
    expect(record.rejectedCount).toBe(2);
    expect(record.totalEstimatedTokens).toBeGreaterThan(0);

    const selected = record.candidates.find((c) => c.status === "selected");
    expect(selected?.name).toBe("react-testing");
    expect(selected?.score).toBe(8);

    const rejected = record.candidates.filter((c) => c.status === "rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.some((c) => c.decisionReason.includes("zero relevance score"))).toBe(true);
    expect(rejected.some((c) => c.decisionReason.includes("invalid skill"))).toBe(true);
  });

  it("persists and loads latest trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillgate-trace-"));
    const record = createTraceRecord({
      task: "test trace",
      root,
      signals: [],
      discoveredSkills: [],
      rankedSkills: [],
    });

    await saveTrace(record, root);
    const loaded = await loadLatestTrace(root);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(record.id);
    expect(loaded?.task).toBe("test trace");

    await rm(root, { recursive: true, force: true });
  });
});
