import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpStdio } from "./stdio.js";

function outputCollector(): { output: Writable; lines: string[] } {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { output, lines };
}

describe("MCP stdio integration", () => {
  it("preserves one JSON-RPC response per request and never replies to notifications", async () => {
    const { output, lines } = outputCollector();
    const chunks = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"client","version":"1"}}}\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"filesystem/read","arguments":{"path":"/etc/passwd"}}}\n',
    ];
    await runMcpStdio(Readable.from(chunks.map((value) => Buffer.from(value))), output);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, result: { tools: [] } });
    expect(JSON.parse(lines[2]!)).toMatchObject({ id: 3, error: { code: -32601 } });
  });

  it("does not unlock tool requests after a malformed initialized notification", async () => {
    const { output, lines } = outputCollector();
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "client", version: "1" },
      } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: [] },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
    ];
    await runMcpStdio(Readable.from(messages.map((value) =>
      Buffer.from(JSON.stringify(value) + "\n"))), output);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 2, error: { code: -32002 } });
    expect(JSON.parse(lines[2]!)).toMatchObject({ id: 3, result: { tools: [] } });
  });

  it("resumes after stdout backpressure drains", async () => {
    const lines: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        setImmediate(callback);
      },
    });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    await runMcpStdio(Readable.from([Buffer.from(ping)]), output);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("waits for a successful asynchronous write callback even without backpressure", async () => {
    let completeWrite: (() => void) | undefined;
    const output = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\\n";
    let settled = false;
    const pending = runMcpStdio(Readable.from([Buffer.from(ping)]), output)
      .finally(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(completeWrite).toBeTypeOf("function");
    completeWrite?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("fails safely on an asynchronous write error when stdout was not backpressured", async () => {
    const output = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(new Error("secret filesystem detail")));
      },
    });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\\n";
    await expect(runMcpStdio(Readable.from([Buffer.from(ping)]), output))
      .rejects.toThrow("MCP output failed");
    // Writable emits its error event after the write callback. It must be
    // consumed rather than becoming an uncaught process-level exception.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(output.listenerCount("error")).toBe(0);
  });

  it("rejects a closed stdout instead of hanging while waiting for drain", async () => {
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Simulate a stalled client: the write never drains.
      },
    });
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    const pending = runMcpStdio(Readable.from([Buffer.from(ping)]), output);
    setImmediate(() => output.destroy());
    await expect(pending).rejects.toThrow("MCP output closed");
  });

  it("fails closed on malformed UTF-8 without emitting a JSON-RPC response", async () => {
    const { output, lines } = outputCollector();
    await expect(runMcpStdio(Readable.from([Buffer.from([0xff, 10])]), output)).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it("escapes Unicode line separators from client-controlled request ids", async () => {
    const { output, lines } = outputCollector();
    const request = JSON.stringify({ jsonrpc: "2.0", id: "id\u2028break", method: "ping" }) + "\n";
    await runMcpStdio(Readable.from([Buffer.from(request)]), output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\\u2028");
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "id\u2028break", result: {} });
  });
});
