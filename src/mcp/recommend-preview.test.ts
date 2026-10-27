import { describe, expect, it } from "vitest";
import { Readable, Writable } from "node:stream";
import { McpJsonRpcSession, MCP_PROTOCOL_VERSION } from "./json-rpc.js";
import { RECOMMEND_PREVIEW_TOOL, recommendPreviewResult } from "./recommend-preview.js";

const skills = [
  { id: "react", name: "React Components", description: "Build components", capabilities: ["filesystem"] },
  { id: "network", name: "React Network", description: "Build components", capabilities: ["network"] },
  { id: "python", name: "Python CLI", description: "Build scripts", capabilities: [] },
];
const args = {
  task: "react", skills,
  policy: { defaultAction: "allow" as const, deniedCapabilities: ["network"] },
  limit: 8,
};

describe("filesystem-free MCP recommendation preview", () => {
  it("filters denied candidates before ranking and never grants authorization", () => {
    const result = recommendPreviewResult(args);
    expect(result).not.toBeNull();
    expect(result!.structuredContent).toEqual({
      schemaVersion: "1", policySource: "client-supplied",
      authorizationGranted: false, filesystemAccess: "disabled",
      ranked: [{ id: "react", name: "React Components", score: 5,
        reasons: [{ source: "name", term: "react", points: 5 }] }],
    });
    expect(JSON.parse((result!.content as Array<{ text: string }>)[0]!.text))
      .toEqual(result!.structuredContent);
    expect(JSON.stringify(result)).not.toContain("React Network");
    expect(RECOMMEND_PREVIEW_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(RECOMMEND_PREVIEW_TOOL.outputSchema.additionalProperties).toBe(false);
  });

  it("does not confuse hypothetical policy allow with actual authorization", () => {
    const result = recommendPreviewResult({ ...args, policy: { defaultAction: "allow" } });
    expect(result!.structuredContent).toMatchObject({ authorizationGranted: false,
      policySource: "client-supplied", filesystemAccess: "disabled" });
    expect((result!.structuredContent as { ranked: unknown[] }).ranked).toHaveLength(2);
  });

  it("validates policy even with zero candidates", () => {
    expect(recommendPreviewResult({ task: "react", skills: [], policy: { deniedSkills: [1] } }))
      .toBeNull();
    expect(recommendPreviewResult({ task: "react", skills: [], policy: {} }))
      .toMatchObject({ structuredContent: { ranked: [] } });
  });

  it.each([
    { ...args, root: "/etc" },
    { ...args, skills: [...skills, { ...skills[0] }] },
    { ...args, skills: [{ ...skills[0], path: "/etc/passwd" }] },
    { ...args, skills: [{ ...skills[0], name: "bad\u202e" }] },
    { ...args, skills: [{ ...skills[0], capabilities: ["bad\ud800"] }] },
    { ...args, skills: [{ ...skills[0], id: "../escape" }] },
    { ...args, skills: [{ ...skills[0], description: "x".repeat(513) }] },
    { ...args, skills: Array.from({ length: 65 }, (_, i) =>
      ({ id: "s" + i, name: "React", description: "" })) },
    { ...args, limit: 9 },
    { ...args, policy: { defaultAction: "allow", policyPath: "/etc/policy" } },
    { ...args, policy: { deniedSkills: ["bad\udc00"] } },
    { ...args, task: "" },
  ])("fails closed for malformed or unauthorized metadata %#", (input) => {
    expect(recommendPreviewResult(input)).toBeNull();
  });

  it("rejects malformed denied candidates instead of silently dropping them", () => {
    expect(recommendPreviewResult({ ...args,
      skills: [{ ...skills[1], id: "../bad" }],
    })).toBeNull();
  });

  it("advertises the same bounded closed schema as the underlying tools", () => {
    expect(RECOMMEND_PREVIEW_TOOL.inputSchema.properties.skills.maxItems).toBe(64);
    expect(RECOMMEND_PREVIEW_TOOL.inputSchema.properties.skills.items.additionalProperties).toBe(false);
    expect(RECOMMEND_PREVIEW_TOOL.inputSchema.properties.policy.additionalProperties).toBe(false);
    expect(RECOMMEND_PREVIEW_TOOL.outputSchema.properties.ranked.maxItems).toBe(8);
  });

  it("is callable only after MCP initialization", () => {
    const session = new McpJsonRpcSession();
    const call = (id: number) => session.handle({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: RECOMMEND_PREVIEW_TOOL.name, arguments: args } });
    expect(call(1)).toMatchObject({ error: { code: -32002 } });
    expect(session.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" },
    } })).toMatchObject({ result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ result: { tools: expect.arrayContaining([{ name: RECOMMEND_PREVIEW_TOOL.name }]) } });
    expect(call(4)).toMatchObject({ result: { structuredContent: {
      authorizationGranted: false, ranked: expect.arrayContaining([{ id: "react" }]),
    } } });
  });

  it("runs the preview over the actual stdio JSON-RPC transport", async () => {
    const { runMcpStdio } = await import("./stdio.js");
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: RECOMMEND_PREVIEW_TOOL.name, arguments: args,
      } },
    ];
    let output = "";
    const writable = new Writable({ write(chunk, _encoding, callback) {
      output += chunk.toString(); callback();
    } });
    await runMcpStdio(Readable.from([Buffer.from(requests.map((r) => JSON.stringify(r)).join("\n") + "\n")]), writable);
    const responses = output.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({ id: 2, result: {
      structuredContent: { authorizationGranted: false, ranked: [{ id: "react" }] },
    } });
  });
});
