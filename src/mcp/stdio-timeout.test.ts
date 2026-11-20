import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MCP_WRITE_TIMEOUT_MS, runMcpStdio } from "./stdio.js";

const ping = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");

describe("MCP stdio stalled output deadline", () => {
  it("fails closed when a connected output never acknowledges a write", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let notifyWrite!: () => void;
    let completeWrite!: (error?: Error | null) => void;
    const started = new Promise<void>((resolve) => { notifyWrite = resolve; });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
        // A connected client may stop draining without closing its pipe.
        notifyWrite();
      },
    });
    try {
      const pending = runMcpStdio(Readable.from([ping]), output);
      const rejection = expect(pending).rejects.toThrow("MCP output timed out");
      await started;
      await vi.advanceTimersByTimeAsync(MCP_WRITE_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(output.destroyed).toBe(true);
      // A delayed failed write callback must not emit an uncaught stream
      // error after the transport has already rejected and detached listeners.
      completeWrite(new Error("late write failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output.listenerCount("error")).toBe(0);
      expect(output.listenerCount("close")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline when a slow write completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let notifyWrite!: () => void;
    const started = new Promise<void>((resolve) => { notifyWrite = resolve; });
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(callback, 25);
        notifyWrite();
      },
    });
    try {
      const pending = runMcpStdio(Readable.from([ping]), output);
      await started;
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();
      expect(output.destroyed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(output.listenerCount("error")).toBe(0);
      expect(output.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
