import { describe, expect, it } from "vitest";
import { McpJsonRpcSession } from "./json-rpc.js";

const initialize = (id: unknown, name = "client", version = "1") => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version } },
});

describe("MCP JSON-RPC Unicode protocol identifiers", () => {
  it.each(["\ud800", "\udc00", "prefix\ud800suffix", "\ud800x\udc00"])(
    "rejects malformed Unicode request IDs without reflecting them", (id) => {
      const session = new McpJsonRpcSession();
      expect(session.handle(initialize(id))).toMatchObject({ id: null, error: { code: -32600 } });
      expect(session.handle(initialize("valid"))).toMatchObject({ id: "valid", result: {} });
    },
  );

  it("rejects malformed method names", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({ jsonrpc: "2.0", id: 1, method: "ping\ud800" }))
      .toMatchObject({ id: null, error: { code: -32600 } });
  });

  it.each(["\ud800", "\udc00"])(
    "rejects malformed Unicode client metadata", (invalid) => {
      const session = new McpJsonRpcSession();
      expect(session.handle(initialize(1, invalid))).toMatchObject({ id: 1, error: { code: -32602 } });
      expect(session.handle(initialize(2, "client", invalid))).toMatchObject({ id: 2, error: { code: -32602 } });
    },
  );

  it("preserves valid surrogate pairs", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize("🛡️", "🛡️", "1"))).toMatchObject({ id: "🛡️", result: {} });
  });
});
