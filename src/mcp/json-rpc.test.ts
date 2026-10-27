import { describe, expect, it } from "vitest";
import { McpJsonRpcSession, MCP_PROTOCOL_VERSION, MCP_STATUS_SCHEMA_VERSION } from "./json-rpc.js";

const initialize = (id: string | number = 1) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {}, clientInfo: { name: "test-client", version: "1" } },
});

describe("MCP JSON-RPC session", () => {
  it("negotiates initialization and exposes only filesystem-free tools", () => {
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
      .toMatchObject({ jsonrpc: "2.0", id: 2, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "filesystem/read", arguments: { path: "/etc/passwd" } } }))
      .toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool" } });
  });

  it("rejects unknown initialize fields and malformed metadata before the handshake", () => {
    const session = new McpJsonRpcSession();
    for (const extra of [
      { root: "/etc" },
      { path: "/etc/passwd" },
      { _meta: null },
      { _meta: [] },
    ]) {
      expect(session.handle({ ...initialize(1), params: { ...initialize(1).params, ...extra } }))
        .toMatchObject({ id: 1, error: { code: -32602, message: "Invalid initialize parameters" } });
    }
    // Failed requests cannot consume initialization; standard MCP metadata is allowed.
    expect(session.handle({ ...initialize(2), params: {
      ...initialize(2).params, _meta: { "client/trace": "safe" },
    } })).toMatchObject({ id: 2, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ id: 3, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
  });

  it("rejects unexpected ping parameters without breaking a valid session", () => {
    const session = new McpJsonRpcSession();
    for (const params of [
      { root: "/etc" },
      { path: "/etc/passwd" },
      { _meta: null },
      { _meta: [] },
    ]) {
      expect(session.handle({ jsonrpc: "2.0", id: 1, method: "ping", params }))
        .toEqual({ jsonrpc: "2.0", id: 1,
          error: { code: -32602, message: "Invalid ping parameters" } });
    }
    for (const params of [undefined, {}, { _meta: { "client/trace": "safe" } }]) {
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "ping", ...(params === undefined ? {} : { params }) }))
        .toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    }
    expect(session.handle(initialize(3))).toMatchObject({ id: 3, result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" }))
      .toMatchObject({ id: 4, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
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
    for (const params of [null, 42, [], "invalid",
      { path: "/etc/passwd" }, { _meta: null }, { _meta: [] }]) {
      expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized", params }))
        .toBeNull();
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
        .toMatchObject({ id: 2, error: { code: -32002 } });
    }
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }))
      .toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ id: 3, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });

    // Standard object-valued MCP metadata remains accepted on initialized.
    const withMeta = new McpJsonRpcSession();
    expect(withMeta.handle(initialize(4))).toMatchObject({ id: 4, result: {} });
    expect(withMeta.handle({ jsonrpc: "2.0", method: "notifications/initialized",
      params: { _meta: { "client/trace": "safe" } } })).toBeNull();
    expect(withMeta.handle({ jsonrpc: "2.0", id: 5, method: "tools/list" }))
      .toMatchObject({ id: 5, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
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
      .toMatchObject({ jsonrpc: "2.0", id: 3, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
  });

  it("rejects unexpected tool request fields but permits MCP request metadata", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    for (const params of [
      { path: "/etc/passwd" },
      { unexpected: true },
      { _meta: null },
      { _meta: [] },
    ]) {
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params }))
        .toMatchObject({ id: 2, error: { code: -32602 } });
    }
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list",
      params: { _meta: { "client/trace": "safe" } } }))
      .toMatchObject({ id: 3, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });

    for (const params of [
      { name: "skillgate/status", arguments: {}, path: "/etc/passwd" },
      { name: "skillgate/status", arguments: {}, unexpected: true },
      { name: "skillgate/status", _meta: null },
      { name: "skillgate/status", _meta: [] },
    ]) {
      expect(session.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params }))
        .toMatchObject({ id: 4, error: { code: -32602 } });
    }
    expect(session.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "skillgate/status", arguments: {}, _meta: { "client/trace": "safe" } } }))
      .toMatchObject({ id: 5, result: { structuredContent: { filesystemAccess: "disabled" } } });
  });

  it("serves status without exposing filesystem data and rejects unknown or malformed calls", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const result = session.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "skillgate/status", arguments: {} } });
    expect(result).toMatchObject({ id: 2, result: { content: [{ type: "text" }] } });
    const text = (result?.result?.content as { text: string }[])[0]!.text;
    const expected = {
      schemaVersion: MCP_STATUS_SCHEMA_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      skillToolsAvailable: false,
      filesystemAccess: "disabled",
    };
    expect(JSON.parse(text)).toEqual(expected);
    expect(result?.result?.structuredContent).toEqual(expected);
    const catalog = session.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const tool = (catalog?.result?.tools as Array<{ outputSchema: Record<string, unknown> }>)[0]!;
    expect(tool.outputSchema).toEqual({
      type: "object",
      properties: {
        schemaVersion: { const: MCP_STATUS_SCHEMA_VERSION },
        protocolVersion: { const: MCP_PROTOCOL_VERSION },
        skillToolsAvailable: { const: false },
        filesystemAccess: { const: "disabled" },
      },
      required: ["schemaVersion", "protocolVersion", "skillToolsAvailable", "filesystemAccess"],
      additionalProperties: false,
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

  it("rejects out-of-band JSON-RPC envelope fields without consuming initialization", () => {
    const session = new McpJsonRpcSession();
    for (const extra of [
      { root: "/etc" },
      { path: "/etc/passwd" },
      { _meta: { "client/trace": "misplaced" } },
      { unexpected: true },
    ]) {
      expect(session.handle({ ...initialize(1), ...extra }))
        .toEqual({ jsonrpc: "2.0", id: null,
          error: { code: -32600, message: "Invalid Request" } });
    }
    expect(session.handle(initialize(2)))
      .toMatchObject({ id: 2, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "ping",
      path: "/etc/passwd" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
    expect(session.handle({ jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "skillgate/status", arguments: {} }, root: "/etc" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
    expect(session.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "skillgate/status", arguments: {} } }))
      .toMatchObject({ id: 5, result: { structuredContent: { filesystemAccess: "disabled" } } });
  });

  it("does not complete the handshake with extra notification envelope fields", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    for (const extra of [{ path: "/etc/passwd" }, { _meta: { root: "/etc" } }]) {
      expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized", ...extra }))
        .toBeNull();
      expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
        .toMatchObject({ id: 2, error: { code: -32002 } });
    }
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized",
      params: { _meta: { "client/trace": "valid" } } })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ id: 3, result: { tools: expect.arrayContaining([{ name: "skillgate/status" }]) } });
  });
});


describe("malformed no-id MCP notifications", () => {
  it("never emits unsolicited responses for invalid notification envelopes", () => {
    const session = new McpJsonRpcSession();
    const invalid = [
      { jsonrpc: "1.0", method: "notifications/initialized" },
      { jsonrpc: null, method: "notifications/initialized" },
      { jsonrpc: "2.0", method: 42 },
      { jsonrpc: "2.0", method: "ping" + String.fromCharCode(0xd800) },
    ];
    for (const message of invalid) {
      expect(session.handle(message)).toBeNull();
    }
    // Malformed notifications cannot consume the one-time initialize request.
    expect(session.handle(initialize(1))).toMatchObject({ id: 1, result: {} });
    expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
      .toMatchObject({ id: 2, error: { code: -32002 } });
    for (const message of invalid) expect(session.handle(message)).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .toMatchObject({ id: 3, error: { code: -32002 } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(session.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" }))
      .toMatchObject({ id: 4, result: { tools: expect.any(Array) } });
  });

  it("still returns Invalid Request for malformed requests with IDs and non-objects", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({ jsonrpc: "1.0", id: 7, method: "ping" }))
      .toEqual({ jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "Invalid Request" } });
    expect(session.handle(42))
      .toEqual({ jsonrpc: "2.0", id: null,
        error: { code: -32600, message: "Invalid Request" } });
  });
});


describe("MCP reflected request-ID safety", () => {
  it.each(["\u0000", "\u001b[31m", "\n", "\u0085", "\u009f",
    "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069"])(
    "rejects control and bidi characters before echoing a JSON-RPC ID", (control) => {
      const session = new McpJsonRpcSession();
      expect(session.handle({ jsonrpc: "2.0", id: "request" + control,
        method: "ping" })).toEqual({
        jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
      });
      expect(session.handle(initialize("safe"))).toMatchObject({
        id: "safe", result: { protocolVersion: MCP_PROTOCOL_VERSION },
      });
    },
  );

  it("allows ordinary international IDs and the empty string ID", () => {
    const session = new McpJsonRpcSession();
    for (const id of ["", "request-1", "東京 🛡️", "בקשה"]) {
      expect(session.handle({ jsonrpc: "2.0", id, method: "ping" }))
        .toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });
});
