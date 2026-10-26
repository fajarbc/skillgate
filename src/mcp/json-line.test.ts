import { describe, expect, it } from "vitest";
import { McpFramingError, McpJsonLineDecoder } from "./json-line.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("MCP stdio framing", () => {
  it("decodes multiple JSON-RPC messages and CRLF without leaking framing bytes", () => {
    const decoder = new McpJsonLineDecoder();
    expect(decoder.push(bytes('{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc":"2.0","method":"initialize"}\r\n')))
      .toEqual([{ jsonrpc: "2.0", method: "ping" }, { jsonrpc: "2.0", method: "initialize" }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("preserves UTF-8 split across incoming chunks and copies mutable buffers", () => {
    const decoder = new McpJsonLineDecoder();
    const first = bytes('{"task":"💡"}\n');
    const remainder = first.slice(10);
    expect(decoder.push(first.subarray(0, 10))).toEqual([]);
    first.fill(0);
    // The pending buffer is not an alias of the caller's reusable memory.
    expect(decoder.push(remainder)).toEqual([{ task: "💡" }]);
    decoder.finish();
  });

  it("handles a long line fragmented into single-byte chunks within its byte budget", () => {
    const payload = { jsonrpc: "2.0", id: 7, method: "ping", data: "x".repeat(65536) };
    const line = bytes(JSON.stringify(payload) + "\n");
    const decoder = new McpJsonLineDecoder(line.length - 1);
    for (let index = 0; index < line.length - 1; index += 1) {
      expect(decoder.push(line.subarray(index, index + 1))).toEqual([]);
    }
    expect(decoder.push(line.subarray(line.length - 1))).toEqual([payload]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects a byte over the limit after fragmented input and stays closed", () => {
    const decoder = new McpJsonLineDecoder(4);
    for (const byte of bytes("1234")) {
      expect(decoder.push(new Uint8Array([byte]))).toEqual([]);
    }
    expect(() => decoder.push(bytes("5\n"))).toThrow(new McpFramingError("too_large"));
    expect(() => decoder.push(bytes("{}\n"))).toThrow(new McpFramingError("incomplete"));
  });

  it("rejects malformed UTF-8 and JSON rather than replacing bytes", () => {
    expect(() => new McpJsonLineDecoder().push(new Uint8Array([0xff, 10])))
      .toThrow(new McpFramingError("invalid_utf8"));
    expect(() => new McpJsonLineDecoder().push(bytes('{broken}\n')))
      .toThrow(new McpFramingError("invalid_json"));
    expect(() => new McpJsonLineDecoder().push(bytes('[]\n')))
      .toThrow(new McpFramingError("invalid_json"));
  });

  it("enforces a per-message byte limit even when a line is split", () => {
    const decoder = new McpJsonLineDecoder(7);
    expect(decoder.push(bytes('{"a":'))).toEqual([]);
    expect(() => decoder.push(bytes('123}\n'))).toThrow(new McpFramingError("too_large"));
    expect(() => decoder.push(bytes('{}\n'))).toThrow();
    expect(() => new McpJsonLineDecoder(0)).toThrow(RangeError);
  });

  it("rejects unterminated trailing messages", () => {
    const decoder = new McpJsonLineDecoder();
    decoder.push(bytes('{"jsonrpc":"2.0"}'));
    expect(() => decoder.finish()).toThrow(new McpFramingError("incomplete"));
  });
});
