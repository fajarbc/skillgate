import { describe, expect, it, vi } from "vitest";
import {
  JsonStdinRequestError,
  MAX_JSON_STDIN_BYTES,
  parseJsonStdinRequest,
  readJsonStdinRequest,
} from "./cli-json-stdin.js";

async function* chunks(...parts: Array<string | Uint8Array>) {
  for (const part of parts) yield part;
}

describe("CLI v1 stdin request transport", () => {
  it("preserves multiline Unicode tasks and advisory context paths", async () => {
    const task = "Investigate 日本語\nThen review src/cli.ts 🚀";
    const payload = JSON.stringify({
      protocolVersion: 1,
      task,
      context: { paths: ["src/cli.ts"] },
    });
    const bytes = new TextEncoder().encode(payload);
    const result = await readJsonStdinRequest(chunks(bytes.slice(0, 17), bytes.slice(17)));
    expect(result).toEqual({ protocolVersion: 1, task, context: { paths: ["src/cli.ts"] } });
  });

  it("preserves UTF-16 surrogate pairs split across string chunks at the exact byte limit", async () => {
    const task = "Investigate 🚀 safely";
    const payload = JSON.stringify({ protocolVersion: 1, task });
    const split = payload.indexOf("🚀") + 1;
    // The first chunk ends with the high surrogate; the next begins with
    // the low surrogate. Independent TextEncoder calls corrupt the task.
    const request = await readJsonStdinRequest(
      chunks(payload.slice(0, split), payload.slice(split)),
      Buffer.byteLength(payload, "utf8"),
    );
    expect(request).toEqual({ protocolVersion: 1, task });
  });

  it("rejects unpaired UTF-16 surrogates instead of silently replacing task characters", async () => {
    const prefix = '{"protocolVersion":1,"task":"';
    const suffix = '"}';
    const invalidInputs: Array<Array<string | Uint8Array>> = [
      [prefix + "\udc80" + suffix], // lone low surrogate
      [prefix + "\ud800x" + suffix], // high surrogate followed by non-low
      [prefix + "\ud800", suffix], // high surrogate across incompatible strings
      [prefix + "\ud800", new TextEncoder().encode(suffix)], // mixed binary boundary
      [prefix + "\ud800"], // high surrogate at end of stream
    ];
    for (const parts of invalidInputs) {
      await expect(readJsonStdinRequest(chunks(...parts))).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("surrogate"),
      });
    }
  });

  it("rejects unpaired surrogates introduced by JSON Unicode escapes", async () => {
    // UTF-8 transport is valid here; JSON.parse introduces the lone surrogate.
    // Both task text and advisory paths must reject this silent corruption.
    const invalid = [
      '{"protocolVersion":1,"task":"review \\ud800"}',
      '{"protocolVersion":1,"task":"review \\udc00"}',
      '{"protocolVersion":1,"task":"ok","context":{"paths":["src/\\ud800.ts"]}}',
      '{"protocolVersion":1,"task":"ok","context":{"paths":["src/\\udc00.ts"]}}',
    ];
    for (const payload of invalid) {
      expect(() => parseJsonStdinRequest(payload)).toThrow(JsonStdinRequestError);
      await expect(readJsonStdinRequest(chunks(payload))).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("surrogate"),
      });
    }
    const valid = '{"protocolVersion":1,"task":"review \\ud83d\\ude80","context":{"paths":["src/\\ud83d\\ude80.ts"]}}';
    expect(parseJsonStdinRequest(valid)).toEqual({
      protocolVersion: 1, task: "review 🚀", context: { paths: ["src/🚀.ts"] },
    });
  });

  it("handles many empty and single-byte chunks within a bounded receive buffer", async () => {
    const payload = JSON.stringify({ protocolVersion: 1, task: "fragmented request" });
    async function* fragmented() {
      // Empty chunks do not consume request bytes and must not accumulate
      // one retained allocation per producer yield.
      for (let index = 0; index < 20_000; index++) yield "";
      for (const byte of Buffer.from(payload)) yield Uint8Array.of(byte);
    }
    expect(await readJsonStdinRequest(fragmented(), Buffer.byteLength(payload))).toEqual({
      protocolVersion: 1,
      task: "fragmented request",
    });
  });

  it("snapshots reusable Buffer chunks before their producer mutates them", async () => {
    const request = '{"protocolVersion":1,"task":"shared buffer"}';
    const reused = Buffer.alloc(1);
    async function* input() {
      for (const byte of Buffer.from(request)) {
        reused[0] = byte;
        yield reused;
      }
    }
    expect(await readJsonStdinRequest(input())).toEqual({
      protocolVersion: 1,
      task: "shared buffer",
    });
  });

  it("requires one JSON object with a nonempty task and protocol version", () => {
    for (const invalid of [
      "",
      "{bad",
      "[]",
      "null",
      '{"task":"x"}',
      '{"protocolVersion":1,"task":"  "}',
      '{"protocolVersion":1,"task":42}',
      '{"protocolVersion":1,"task":"x","context":[]}',
      '{"protocolVersion":1,"task":"x","context":{"paths":[null]}}',
    ]) {
      expect(() => parseJsonStdinRequest(invalid)).toThrow(JsonStdinRequestError);
    }
  });

  it("returns a stable unsupported-version code", () => {
    let error: unknown;
    try {
      parseJsonStdinRequest('{"protocolVersion":2,"task":"x"}');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(JsonStdinRequestError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
  });

  it("rejects malformed UTF-8 without replacement characters", async () => {
    await expect(readJsonStdinRequest(chunks(new Uint8Array([0xff])))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "stdin must be valid UTF-8",
    });
  });

  it("enforces a byte limit, including multibyte input, before parsing", async () => {
    await expect(
      readJsonStdinRequest(chunks("🚀".repeat(Math.ceil(MAX_JSON_STDIN_BYTES / 4) + 1))),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("byte limit") });
    await expect(
      readJsonStdinRequest(chunks("x".repeat(MAX_JSON_STDIN_BYTES), "y")),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects oversized string chunks before allocating a UTF-8 buffer", async () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(
        readJsonStdinRequest(chunks("🚀".repeat(Math.floor(MAX_JSON_STDIN_BYTES / 4) + 1))),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("byte limit"),
      });
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("accepts an exactly bounded complete request", async () => {
    const request = '{"protocolVersion":1,"task":"x"}';
    expect(await readJsonStdinRequest(chunks(request), new TextEncoder().encode(request).length)).toEqual({
      protocolVersion: 1,
      task: "x",
    });
  });
});
