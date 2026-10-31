import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpStdio } from "./stdio.js";

const ping = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");

describe("MCP stdio output disconnect safety", () => {
  it("fails when stdout closes after a reply but before stdin EOF", async () => {
    let writes = 0;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        callback();
      },
    });
    async function* input() {
      yield ping;
      // Let the first response finish, then disconnect without sending more
      // requests. A close event must be remembered until EOF is processed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closed = new Promise<void>((resolve) => output.once("close", resolve));
      output.destroy();
      await closed;
    }
    await expect(runMcpStdio(input(), output)).rejects.toThrow("MCP output failed");
    expect(writes).toBe(1);
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("does not report an output disconnect for a normally completed session", async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await expect(runMcpStdio(Readable.from([ping]), output)).resolves.toBeUndefined();
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });
});
