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

  it("streams one frame before parsing the next frame in the same chunk", () => {
    const decoder = new McpJsonLineDecoder();
    const frames = decoder.decode(bytes('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{invalid}\n'));
    expect(frames.next()).toEqual({
      done: false, value: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(() => frames.next()).toThrow(new McpFramingError("invalid_json"));
    expect(() => decoder.push(bytes('{"jsonrpc":"2.0"}\n')))
      .toThrow(new McpFramingError("incomplete"));
  });

  it("iterates thousands of frames from one chunk without collecting a batch", () => {
    const decoder = new McpJsonLineDecoder();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "ping" }) + "\n";
    let count = 0;
    for (const frame of decoder.decode(bytes(line.repeat(2000)))) {
      expect(frame).toEqual({ jsonrpc: "2.0", method: "ping" });
      count++;
    }
    expect(count).toBe(2000);
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

  it("stops scanning oversized single chunks at the frame byte budget", () => {
    // A synthetic input models a multi-gigabyte chunk without allocating it.
    // Reading beyond the first disallowed byte would throw the sentinel error.
    let inspected = 0;
    const hugeChunk = new Proxy({ byteLength: 2 ** 31 }, {
      get(target, key) {
        if (key === "byteLength") return target.byteLength;
        if (typeof key === "string" && /^\d+$/.test(key)) {
          inspected++;
          if (inspected > 6) throw new Error("scanned past the byte budget");
          return 65; // 'A', with no newline in the prefix.
        }
        return undefined;
      },
    }) as unknown as Uint8Array;
    const decoder = new McpJsonLineDecoder(8);
    expect(decoder.push(bytes("123"))).toEqual([]);
    expect(() => decoder.push(hugeChunk)).toThrow(new McpFramingError("too_large"));
    // Three pending bytes plus six examined bytes: the sixth is rejected.
    expect(inspected).toBe(6);
    expect(() => decoder.push(bytes("{}\n"))).toThrow(new McpFramingError("incomplete"));
  });

  it("allows a frame exactly at its byte limit before LF, but counts CR in CRLF", () => {
    const exact = new McpJsonLineDecoder(2);
    expect(exact.push(bytes("{}\n"))).toEqual([{}]);
    expect(() => exact.finish()).not.toThrow();

    const withCr = new McpJsonLineDecoder(2);
    expect(() => withCr.push(bytes("{}\r\n"))).toThrow(new McpFramingError("too_large"));
  });

  it("rejects malformed UTF-8 and JSON rather than replacing bytes", () => {
    expect(() => new McpJsonLineDecoder().push(new Uint8Array([0xff, 10])))
      .toThrow(new McpFramingError("invalid_utf8"));
    expect(() => new McpJsonLineDecoder().push(bytes('{broken}\n')))
      .toThrow(new McpFramingError("invalid_json"));
    for (const primitive of ["[]", "null", "42", "true", '"string"']) {
      const decoder = new McpJsonLineDecoder();
      expect(() => decoder.push(bytes(primitive + "\n")))
        .toThrow(new McpFramingError("invalid_json"));
      // An invalid frame poisons the session; a later object cannot resync it.
      expect(() => decoder.push(bytes("{}\n")))
        .toThrow(new McpFramingError("incomplete"));
    }
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
