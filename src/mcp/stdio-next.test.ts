import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { nextMcpChunk } from "./stdio-next.js";

describe("MCP stdio input wait cancellation", () => {
  it("does not retain one abort listener per completed input chunk", async () => {
    const controller = new AbortController();
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => ({ done: false as const, value: Uint8Array.of(1) }),
    };
    for (let i = 0; i < 10_000; i++) {
      expect((await nextMcpChunk(iterator, controller.signal)).done).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });

  it("rejects an idle read on disconnect and cleans up its listener", async () => {
    const controller = new AbortController();
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
    };
    const pending = nextMcpChunk(iterator, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toThrow("MCP output failed");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(nextMcpChunk(iterator, controller.signal)).rejects.toThrow("MCP output failed");
  });

  it("cleans up when the input iterator throws or rejects", async () => {
    const controller = new AbortController();
    await expect(nextMcpChunk({ next() { throw new Error("sync failure"); } }, controller.signal))
      .rejects.toThrow("sync failure");
    await expect(nextMcpChunk({ next() { return Promise.reject(new Error("async failure")); } }, controller.signal))
      .rejects.toThrow("async failure");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
