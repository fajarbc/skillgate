import { describe, expect, it } from "vitest";
import { POLICY_PREVIEW_TOOL, policyPreviewResult } from "./policy-preview.js";
import { McpJsonRpcSession, MCP_PROTOCOL_VERSION } from "./json-rpc.js";
import { runMcpStdio } from "./stdio.js";
import { Readable, Writable } from "node:stream";

const request = {
  name: "Build API",
  capabilities: ["network", "filesystem"],
  policy: { defaultAction: "allow", deniedCapabilities: ["network"] },
};

describe("MCP caller-supplied policy preview", () => {
  it("reuses the core policy precedence without granting workspace access", () => {
    const result = policyPreviewResult(request);
    expect(result).not.toBeNull();
    const payload = result!.structuredContent;
    expect(payload).toMatchObject({
      schemaVersion: "1", policySource: "client-supplied",
      authorizationGranted: false, filesystemAccess: "disabled",
      decision: "deny", reason: "skill declares denied capability 'network'",
    });
    expect(JSON.parse((result!.content as Array<{ text: string }>)[0]!.text)).toEqual(payload);
    expect(POLICY_PREVIEW_TOOL.outputSchema.additionalProperties).toBe(false);
    expect(POLICY_PREVIEW_TOOL.inputSchema.additionalProperties).toBe(false);
  });

  it("matches allow, deny, default-deny, and prefix semantics from the CLI policy core", () => {
    expect((policyPreviewResult({ name: "Build API", policy: { defaultAction: "allow" } })!
      .structuredContent as { decision: string }).decision).toBe("allow");
    expect((policyPreviewResult({ name: "Build API", policy: { deniedSkills: ["Build*"] } })!
      .structuredContent as { decision: string }).decision).toBe("deny");
    expect((policyPreviewResult({ name: "Build API", policy: { allowedSkills: ["Other*"] } })!
      .structuredContent as { decision: string }).decision).toBe("deny");
    expect((policyPreviewResult({ name: "Build API", policy: { defaultAction: "deny", allowedSkills: ["Build*"] } })!
      .structuredContent as { decision: string }).decision).toBe("deny");
  });

  it.each([
    null, [], {}, { ...request, path: "/etc/passwd" },
    { ...request, name: "" }, { ...request, name: " " },
    { ...request, name: "safe\u202e" }, { ...request, name: "bad\ud800" },
    { ...request, name: "x".repeat(129) }, { ...request, policy: null },
    { ...request, policy: { defaultAction: "invalid" } },
    { ...request, policy: { deniedSkills: ["safe"], policyPath: "/etc" } },
    { ...request, policy: { deniedSkills: ["/etc\n"] } },
    { ...request, policy: { deniedSkills: ["bad\udc00"] } },
    { ...request, policy: { deniedSkills: Array(33).fill("safe") } },
    { ...request, capabilities: Array(17).fill("network") },
    { ...request, capabilities: ["safe", "\u202e"] },
    { ...request, capabilities: "network" },
  ])("fails closed for invalid policy preview arguments %#", (args) => {
    expect(policyPreviewResult(args)).toBeNull();
  });

  it("accepts valid international names and patterns", () => {
    const result = policyPreviewResult({
      name: "日本語 🛡️", capabilities: ["网络"],
      policy: { deniedSkills: ["日本語*"] },
    });
    expect(result?.structuredContent).toMatchObject({
      decision: "deny", authorizationGranted: false,
    });
  });

  it("enforces session handshake and refuses filesystem tools", () => {
    const session = new McpJsonRpcSession();
    const call = (id: number, name: string, args: unknown) => session.handle({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    });
    expect(call(1, POLICY_PREVIEW_TOOL.name, request)).toMatchObject({ error: { code: -32002 } });
    expect(session.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" },
    } })).toMatchObject({ result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ result: { tools: expect.arrayContaining([{ name: POLICY_PREVIEW_TOOL.name }]) } });
    expect(call(4, POLICY_PREVIEW_TOOL.name, request)).toMatchObject({
      result: { structuredContent: { decision: "deny", authorizationGranted: false } },
    });
    expect(call(5, POLICY_PREVIEW_TOOL.name, { ...request, root: "/etc" }))
      .toMatchObject({ error: { code: -32602 } });
    expect(call(6, "filesystem/read", { path: "/etc/passwd" }))
      .toMatchObject({ error: { code: -32602 } });
  });

  it("keeps stdio JSON-RPC output isolated and versioned", async () => {
    const output: string[] = [];
    const writer = new Writable({ write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString("utf8")); callback();
    } });
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: POLICY_PREVIEW_TOOL.name, arguments: request } },
      { jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: POLICY_PREVIEW_TOOL.name, arguments: { ...request, path: "/etc/passwd" } } },
    ];
    await runMcpStdio(Readable.from(lines.map((line) => Buffer.from(JSON.stringify(line) + "\n"))), writer);
    expect(output).toHaveLength(3);
    expect(output.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(JSON.parse(output[1]!)).toMatchObject({
      id: 2, result: { structuredContent: { decision: "deny", authorizationGranted: false } },
    });
    expect(JSON.parse(output[2]!)).toMatchObject({ id: 3, error: { code: -32602 } });
    expect(output.join("")).not.toContain("/etc/passwd");
  });

  it("rejects malformed Unicode and bidi controls over actual JSONL framing without echoing them", async () => {
    const output: string[] = [];
    const writer = new Writable({ write(chunk: Buffer, _encoding, callback) {
      output.push(chunk.toString("utf8")); callback();
    } });
    const badInputs = [
      { ...request, name: "Build" + String.fromCharCode(0x202e) + " API" },
      { ...request, capabilities: ["network", String.fromCharCode(0xd800)] },
      { ...request, policy: { deniedSkills: ["Build" + String.fromCharCode(0x0085)] } },
    ];
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...badInputs.map((arguments_, index) => ({
        jsonrpc: "2.0", id: index + 2, method: "tools/call",
        params: { name: POLICY_PREVIEW_TOOL.name, arguments: arguments_ },
      })),
      { jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: POLICY_PREVIEW_TOOL.name, arguments: request } },
    ];
    await runMcpStdio(Readable.from(messages.map((message) =>
      Buffer.from(JSON.stringify(message) + "\n"))), writer);
    expect(output).toHaveLength(5);
    for (let i = 1; i <= 3; i++) {
      expect(JSON.parse(output[i]!)).toMatchObject({ id: i + 1, error: { code: -32602 } });
    }
    expect(JSON.parse(output[4]!)).toMatchObject({
      id: 5, result: { structuredContent: { decision: "deny", authorizationGranted: false } },
    });
    expect(output.join("")).not.toContain(String.fromCharCode(0x202e));
    expect(output.join("")).not.toContain(String.fromCharCode(0x0085));
    expect(output.every((line) => line.endsWith("\n"))).toBe(true);
  });
});
