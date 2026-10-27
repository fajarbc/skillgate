import { describe, expect, it } from "vitest";
import { MCP_RANK_PREVIEW_SCHEMA_VERSION, RANK_PREVIEW_TOOL, rankPreviewResult } from "./rank-preview.js";

const skills = [
  { id: "react", name: "React Components", description: "Build components" },
  { id: "python", name: "Python Utilities", description: "CLI scripting" },
];

describe("filesystem-free MCP rank-metadata preview", () => {
  it("uses the shared SkillGate ranking core without asserting policy approval", () => {
    const result = rankPreviewResult({ task: "react component", skills, limit: 1 });
    expect(result).not.toBeNull();
    const payload = result!.structuredContent;
    expect(payload).toEqual({
      schemaVersion: MCP_RANK_PREVIEW_SCHEMA_VERSION,
      policyEvaluated: false,
      filesystemAccess: "disabled",
      ranked: [{
        id: "react", name: "React Components", score: 5,
        reasons: [{ source: "name", term: "react", points: 5 }],
      }],
    });
    expect(JSON.parse((result!.content as Array<{ text: string }>)[0]!.text)).toEqual(payload);
    expect(JSON.stringify(result)).not.toContain("/etc/");
    expect(RANK_PREVIEW_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(RANK_PREVIEW_TOOL.outputSchema.additionalProperties).toBe(false);
  });

  it("returns an empty ranking for empty or unmatched client metadata", () => {
    expect((rankPreviewResult({ task: "react", skills: [] })?.structuredContent as
      { ranked: unknown[] }).ranked).toEqual([]);
    expect((rankPreviewResult({ task: "golang", skills })?.structuredContent as
      { ranked: unknown[] }).ranked).toEqual([]);
  });

  it.each([
    undefined, null, [], {}, { task: "", skills }, { task: " ", skills },
    { task: "x".repeat(4097), skills }, { task: "react", skills: null },
    { task: "react", skills: Array.from({ length: 65 }, (_, i) =>
      ({ id: "s" + i, name: "Skill", description: "" })) },
    { task: "react", skills, path: "/etc/passwd" },
    { task: "react", skills, limit: 0 }, { task: "react", skills, limit: 9 },
    { task: "react", skills, limit: 1.5 }, { task: "react", skills, limit: null },
    { task: "react", skills: [...skills, skills[0]] },
    { task: "react", skills: [{ id: "../passwd", name: "React", description: "" }] },
    { task: "react", skills: [{ id: "react", name: "", description: "" }] },
    { task: "react", skills: [{ id: "react", name: "React", description: "", path: "/etc" }] },
    { task: "react", skills: [{ id: "react", name: "React", description: "x".repeat(513) }] },
  ])("fails closed on malformed client-supplied ranking arguments %#", (args) => {
    expect(rankPreviewResult(args)).toBeNull();
  });
});
