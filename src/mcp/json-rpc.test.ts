import { describe, expect, it } from "vitest";
import { McpJsonRpcSession, MCP_PROTOCOL_VERSION } from "./json-rpc.js";

const initialize = (id: string | number = 1) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {}, clientInfo: { name: "test-client", version: "1" } },
});

describe("MCP JSON-RPC session", () => {
  it("negotiates initialization, then exposes only the filesystem-free status tool", () => {
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
      .toMatchObject({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "skillgate/status" }] } });
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "filesystem/read", arguments: { path: "/etc/passwd" } } }))
      .toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool" } });
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
      .toMatchObject({ id: 3, result: { tools: [{ name: "skillgate/status" }] } });
  });

  it("rejects pagination cursors for the deliberately empty tool catalog", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    for (const cursor of ["next-page", "", null, 123]) {
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor } }))
        .toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "Invalid tool list cursor" } });
    }
    // No cursor means the one and only page; the failed requests do not
    // invalidate the initialized session or expose any filesystem tool.
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }))
      .toMatchObject({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "skillgate/status" }] } });
  });

  it("serves status without exposing filesystem data and rejects unknown or malformed calls", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const result = session.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "skillgate/status", arguments: {} } });
    expect(result).toMatchObject({ id: 2, result: { content: [{ type: "text" }] } });
    const text = (result?.result?.content as { text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      skillToolsAvailable: false,
      filesystemAccess: "disabled",
    });
    for (const params of [
      { name: "filesystem/read", arguments: { path: "/etc/passwd" } },
      { name: "skillgate/status", arguments: { path: "/etc/passwd" } },
      { name: "skillgate/status", arguments: [] },
      { name: "skillgate/status", arguments: null },
      { name: "skillgate/status", arguments: "secret" },
      { name: 42 },
    ]) {
      expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params }))
        .toMatchObject({ id: 3, error: { code: -32602 } });
    }
  });

  it("rejects lossy or fractional JSON-RPC numeric IDs before initialization", () => {
    const session = new McpJsonRpcSession();
    for (const id of [-0, 1.5, -0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, Infinity, NaN]) {
      expect(session.handle(initialize(id))).toEqual({
        jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
      });
    }
    // JSON.parse preserves negative zero, but JSON.stringify would change its ID to 0.
    expect(session.handle(JSON.parse('{"jsonrpc":"2.0","id":-0,"method":"initialize"}')))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    // Valid IDs still round-trip exactly; invalid IDs must not consume initialize.
    expect(session.handle(initialize(Number.MAX_SAFE_INTEGER))).toMatchObject({
      id: Number.MAX_SAFE_INTEGER, result: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
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
