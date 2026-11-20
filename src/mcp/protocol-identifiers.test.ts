import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { McpJsonRpcSession } from "./json-rpc.js";
import { runMcpStdio } from "./stdio.js";

const initialize = (id: number) => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "client", version: "1" },
  },
});

describe("MCP client identity validation", () => {
  it("rejects blank, control, and malformed Unicode identifiers before handshake", () => {
    const invalid = ["", " ", "\t", "\n", "\u0000", "\u007f", "name\nversion",
      String.fromCharCode(0xd800)];
    for (const field of ["protocolVersion", "name", "version"] as const) {
      for (const value of invalid) {
        const session = new McpJsonRpcSession();
        const request = initialize(1);
        if (field === "protocolVersion") request.params.protocolVersion = value;
        else request.params.clientInfo[field] = value;
        expect(session.handle(request)).toMatchObject({ id: 1, error: { code: -32602 } });
        expect(session.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
          .toMatchObject({ id: 2, error: { code: -32002 } });
        expect(session.handle(initialize(3)))
          .toMatchObject({ id: 3, result: { protocolVersion: "2025-06-18" } });
      }
    }
  });

  it("accepts valid Unicode names and ordinary version text", () => {
    const session = new McpJsonRpcSession();
    const request = initialize(1);
    request.params.clientInfo.name = "🛡️ client";
    request.params.clientInfo.version = "2.0-beta";
    expect(session.handle(request)).toMatchObject({
      id: 1, result: { protocolVersion: "2025-06-18" },
    });
  });

  it("rejects malformed identities over stdio without contaminating stdout", async () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const blankProtocol = initialize(1);
    blankProtocol.params.protocolVersion = " ";
    const controlName = initialize(2);
    controlName.params.clientInfo.name = "bad\u0000name";
    const frames = [
      blankProtocol, controlName, initialize(3),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ];
    await runMcpStdio(Readable.from(frames.map((frame) =>
      Buffer.from(JSON.stringify(frame) + "\n"))), output);
    expect(lines).toHaveLength(4);
    const responses = lines.map((line) => JSON.parse(line));
    expect(responses[0]).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(responses[1]).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(responses[2]).toMatchObject({ id: 3, result: { protocolVersion: "2025-06-18" } });
    expect(responses[3]).toMatchObject({ id: 4, result: { tools: expect.any(Array) } });
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.join("")).not.toContain("bad");
  });
});
