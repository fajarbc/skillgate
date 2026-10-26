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

  it("rejects malformed request params and empty initialization identity", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({ jsonrpc: "2.0", id: 1, method: "ping", params: 42 }))
      .toMatchObject({ id: 1, error: { code: -32602, message: "Invalid params" } });
    expect(session.handle({ jsonrpc: "2.0", id: 2, method: "ping", params: [] }))
      .toMatchObject({ id: 2, error: { code: -32602 } });
    expect(session.handle({ ...initialize(3), params: {
      protocolVersion: "", capabilities: {}, clientInfo: { name: "client", version: "1" },
    } })).toMatchObject({ id: 3, error: { code: -32602 } });
    expect(session.handle({ ...initialize(4), params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "", version: "1" },
    } })).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(session.handle({ ...initialize(5), params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "client", version: "" },
    } })).toMatchObject({ id: 5, error: { code: -32602 } });
    // Invalid requests must not advance the session to the initialized state.
    expect(session.handle(initialize(6))).toMatchObject({ id: 6, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 7, method: "ping" }))
      .toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("does not advance handshake for malformed initialized notifications", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    for (const params of [null, 42, [], "invalid"]) {
      expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized", params }))
        .toBeNull();
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
        .toMatchObject({ id: 2, error: { code: -32002 } });
    }
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }))
      .toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ id: 3, result: { tools: [] } });
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
