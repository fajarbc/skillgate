import { describe, expect, it } from "vitest";
import { McpJsonRpcSession, MCP_PROTOCOL_VERSION } from "./json-rpc.js";

const initialize = (id: string | number = 1) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {}, clientInfo: { name: "test-client", version: "1" } },
});

describe("MCP JSON-RPC session", () => {
  it("negotiates initialization, then exposes no unsafe tools", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .toMatchObject({ error: { code: -32002 } });
    expect(session.handle(initialize("start"))).toEqual({
      jsonrpc: "2.0", id: "start", result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "skillgate", version: "0.0.0" },
      },
    });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
      .toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "filesystem/read", arguments: { path: "/etc/passwd" } } }))
      .toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found" } });
  });

  it("rejects invalid requests and does not reflect client-controlled strings", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({ jsonrpc: "2.0", id: null, method: "initialize" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
    expect(session.handle({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "SECRET", capabilities: {} } }))
      .toMatchObject({ error: { code: -32602, message: "Invalid initialize parameters" } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 5, method: "ping" }))
      .toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    expect(session.handle(initialize())).toMatchObject({ id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(session.handle(initialize(2))).toMatchObject({ error: { code: -32600 } });
  });
});
