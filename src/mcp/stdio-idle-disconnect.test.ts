import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpStdio } from "./stdio.js";

function sink(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

describe("MCP stdio idle disconnect and input cleanup", () => {
  it("terminates when stdout closes while stdin is open and idle", async () => {
    const input = new PassThrough();
    const output = sink();
    const running = runMcpStdio(input, output);
    output.destroy();

    await expect(running).rejects.toThrow("MCP output failed");
    expect(input.destroyed).toBe(true);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("terminates on a stdout error without waiting for another request", async () => {
    const input = new PassThrough();
    const output = sink();
    const running = runMcpStdio(input, output);
    output.emit("error", new Error("secret filesystem path"));

    await expect(running).rejects.toThrow("MCP output failed");
    expect(input.destroyed).toBe(true);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("rejects already-destroyed stdout even when no input is forthcoming", async () => {
    const input = new PassThrough();
    const output = sink();
    output.destroy();

    await expect(runMcpStdio(input, output)).rejects.toThrow("MCP output failed");
    expect(input.destroyed).toBe(true);
  });

  it("requests cancellation of non-Readable async iterators after disconnect", async () => {
    let returned = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const output = sink();
    const running = runMcpStdio(input, output);
    output.destroy();

    await expect(running).rejects.toThrow("MCP output failed");
    expect(returned).toBe(true);
  });

  it("closes unfinished stdin after a malformed JSON frame", async () => {
    const input = new PassThrough();
    const output = sink();
    const running = runMcpStdio(input, output);
    input.write(Buffer.from("{invalid}\n"));

    await expect(running).rejects.toThrow("Invalid MCP stdio message: invalid_json");
    expect(input.destroyed).toBe(true);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("preserves successful sessions and removes output listeners", async () => {
    const input = new PassThrough();
    const output = sink();
    const running = runMcpStdio(input, output);
    input.end(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n"));

    await expect(running).resolves.toBeUndefined();
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });
});
