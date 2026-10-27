import { describe, expect, it } from "vitest";
import { McpJsonRpcSession } from "./json-rpc.js";

const initialize = (protocolVersion: string, name: string, version: string) => ({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name, version } },
});

describe("MCP handshake identifier display safety", () => {
  it.each([0x0085, 0x009f, 0x061c, 0x200e, 0x200f, 0x202e, 0x202a, 0x2066, 0x2069]\n    .map((code) => String.fromCharCode(code)))(
    "rejects invisible and bidirectional formatting controls in protocol identifiers", (control) => {
      for (const [protocol, name, version] of [
        ["2025-06-18" + control, "client", "1"],
        ["2025-06-18", "client" + control, "1"],
        ["2025-06-18", "client", "1" + control],
      ]) {
        const session = new McpJsonRpcSession();
        expect(session.handle(initialize(protocol, name, version)))
          .toMatchObject({ id: 1, error: { code: -32602 } });
        expect(session.handle(initialize("2025-06-18", "client", "1")))
          .toMatchObject({ id: 1, result: {} });
      }
    },
  );

  it("preserves ordinary international names and Unicode emoji", () => {
    const session = new McpJsonRpcSession();
    expect(session.handle(initialize("2025-06-18", "Klien 東京 🛡️", "1.0")))
      .toMatchObject({ id: 1, result: {} });
  });
});
