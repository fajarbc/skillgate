import { describe, expect, it } from "vitest";
import {
  JSON_PROTOCOL_VERSION,
  jsonFailure,
  jsonLine,
  jsonSuccess,
} from "./cli-json-protocol.js";

describe("versioned CLI JSON protocol", () => {
  it("emits a stable success envelope with a single terminating newline", () => {
    const data = { task: "first line\nsecond line", count: 2 };
    const line = jsonLine(jsonSuccess("recommend", data));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.endsWith("\n\n")).toBe(false);
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({
      protocolVersion: JSON_PROTOCOL_VERSION,
      command: "recommend",
      ok: true,
      data,
    });
  });

  it("preserves Unicode and multiline payloads as JSON data, not extra output lines", () => {
    const payload = { description: "日本語\nمرحبا\r\nemoji 🚀" };
    const line = jsonLine(jsonSuccess("scan", payload));
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line).data).toEqual(payload);
  });

  it("emits structured failures without a success data field", () => {
    const failure = jsonFailure("recommend", "INVALID_REQUEST", "Task is required");
    expect(JSON.parse(jsonLine(failure))).toEqual({
      protocolVersion: 1,
      command: "recommend",
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Task is required" },
    });
    expect(failure).not.toHaveProperty("data");
  });

  it("supports argument errors before a command is known", () => {
    expect(JSON.parse(jsonLine(jsonFailure(null, "UNSUPPORTED_PROTOCOL", "Unsupported version"))))
      .toMatchObject({
        protocolVersion: 1,
        command: null,
        ok: false,
        error: { code: "UNSUPPORTED_PROTOCOL" },
      });
  });

  it("never appends an extra newline for an empty result", () => {
    expect(jsonLine(jsonSuccess("doctor", {}))).toBe(
      '{"protocolVersion":1,"command":"doctor","ok":true,"data":{}}\n',
    );
  });

  it("escapes Unicode line separators without changing parsed payloads", () => {
    const payload = { task: "alpha\u0085beta\u2028gamma\u2029delta" };
    const line = jsonLine(jsonSuccess("recommend", payload));
    expect(line).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line).data).toEqual(payload);
  });

});
