import { describe, expect, it } from "vitest";
import { McpJsonRpcSession } from "./json-rpc.js";

// Security regression matrix: a malformed or unauthorized JSON-RPC envelope
// must never echo caller-supplied filesystem selectors or unlock the session.
// These tests intentionally include values rejected by the wire JSON parser:
// the session boundary must remain safe when invoked directly, too.
const methods = [
  "initialize", "ping", "notifications/initialized",
  "tools/list", "tools/call", "unknown", "\ud800",
];
const params = [
  undefined, null, 42, [], {}, { _meta: {} }, { _meta: null },
  { root: "/etc/passwd" },
  { name: "filesystem/read", arguments: { path: "/etc/passwd" } },
];

describe("MCP request-shape security matrix", () => {
  it("never replies to notification-shaped objects or advances their handshake", () => {
    for (const method of methods) for (const parameter of params) {
      const session = new McpJsonRpcSession();
      const message = {
        jsonrpc: "2.0", method,
        ...(parameter === undefined ? {} : { params: parameter }),
      };
      expect(session.handle(message)).toBeNull();
      expect(session.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
        .toMatchObject({ error: { code: -32002 } });
    }
  });

  it("never reflects paths or produces non-JSON-RPC results for request-shaped objects", () => {
    const ids: unknown[] = [0, 1, -0, 1.5, 2 ** 53, null, "valid", "\ud800", true, [], {}];
    for (const method of methods) for (const id of ids) for (const parameter of params) {
      const message = {
        jsonrpc: "2.0", id, method,
        ...(parameter === undefined ? {} : { params: parameter }),
      };
      const result = new McpJsonRpcSession().handle(message);
      expect(result).not.toBeNull();
      expect(result?.jsonrpc).toBe("2.0");
      expect(JSON.stringify(result)).not.toContain("/etc/passwd");
    }
  });

  it("keeps filesystem selectors denied after a valid initialization", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "client", version: "1" } },
    })).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    expect(session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    for (const argumentsValue of [
      { path: "/etc/passwd" },
      { root: "/etc/passwd" },
      { task: "test", skills: [], path: "/etc/passwd" },
    ]) {
      for (const name of ["skillgate/status", "skillgate/rank-metadata", "skillgate/evaluate-metadata-policy", "filesystem/read"]) {
        const result = session.handle({
          jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name, arguments: argumentsValue },
        });
        expect(result).toMatchObject({ error: { code: -32602 } });
        expect(JSON.stringify(result)).not.toContain("/etc/passwd");
      }
    }
  });
});
