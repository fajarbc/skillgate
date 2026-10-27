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


describe("rank metadata Unicode and schema length parity", () => {
  const emoji = "🛡";
  const loneHigh = String.fromCharCode(0xd800);
  const loneLow = String.fromCharCode(0xdc00);
  const skill = (name: string, description = "") => [{ id: "safe", name, description }];

  it("accepts astral characters up to JSON Schema code-point limits", () => {
    expect(rankPreviewResult({ task: emoji.repeat(4096), skills: [] })).not.toBeNull();
    expect(rankPreviewResult({ task: "react", skills: skill(emoji.repeat(128), emoji.repeat(512)) }))
      .not.toBeNull();
  });

  it("rejects strings above advertised code-point limits", () => {
    expect(rankPreviewResult({ task: emoji.repeat(4097), skills: [] })).toBeNull();
    expect(rankPreviewResult({ task: "react", skills: skill(emoji.repeat(129)) })).toBeNull();
    expect(rankPreviewResult({ task: "react", skills: skill("safe", emoji.repeat(513)) })).toBeNull();
  });

  it.each([loneHigh, loneLow, "a" + loneHigh + "b"])(
    "rejects unpaired UTF-16 surrogates in any metadata text", (invalid) => {
      expect(rankPreviewResult({ task: "react" + invalid, skills: [] })).toBeNull();
      expect(rankPreviewResult({ task: "react", skills: skill("safe" + invalid) })).toBeNull();
      expect(rankPreviewResult({ task: "react", skills: skill("safe", invalid) })).toBeNull();
    },
  );

  it("advertises the same non-whitespace rule enforced at runtime", () => {
    expect(RANK_PREVIEW_TOOL.inputSchema.properties.task.pattern).toBe("\\S");
    expect(RANK_PREVIEW_TOOL.inputSchema.properties.skills.items.properties.name.pattern).toBe("\\S");
    expect(rankPreviewResult({ task: " ", skills: [] })).toBeNull();
    expect(rankPreviewResult({ task: "react", skills: skill(" ") })).toBeNull();
  });
});
