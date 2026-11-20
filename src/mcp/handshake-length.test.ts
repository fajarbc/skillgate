import { describe, expect, it } from "vitest";
import { McpJsonRpcSession } from "./json-rpc.js";

function initialize(protocolVersion: string, name: string, version: string) {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion, capabilities: {}, clientInfo: { name, version },
  } };
}

describe("bounded MCP handshake identifiers", () => {
  it.each([
    ["protocol version", "p".repeat(65), "client", "1"],
    ["client name", "2025-06-18", "n".repeat(129), "1"],
    ["client version", "2025-06-18", "client", "v".repeat(65)],
  ])("rejects oversized %s without advancing handshake", (_label, protocol, name, version) => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize(protocol, name, version)))
      .toMatchObject({ id: 1, error: { code: -32602 } });
    expect(session.handle(initialize("2025-06-18", "client", "1")))
      .toMatchObject({ id: 1, result: {} });
  });

  it("accepts identifier lengths at their exact limits", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize("p".repeat(64), "n".repeat(128), "v".repeat(64))))
      .toMatchObject({ id: 1, result: {} });
  });
});
