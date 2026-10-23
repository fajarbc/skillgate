import { describe, expect, it } from "vitest";
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

  it("accepts an exactly bounded complete request", async () => {
    const request = '{"protocolVersion":1,"task":"x"}';
    expect(await readJsonStdinRequest(chunks(request), new TextEncoder().encode(request).length)).toEqual({
      protocolVersion: 1,
      task: "x",
    });
  });
});
