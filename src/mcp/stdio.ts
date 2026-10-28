#!/usr/bin/env node
/** Local MCP stdio transport. Tools remain disabled until #30 policy validation. */
import { stdin, stdout, stderr } from "node:process";
import { type Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpJsonLineDecoder } from "./json-line.js";
import { McpJsonRpcSession } from "./json-rpc.js";

/** Bound stalled writes even when a client stays connected but stops reading.
 * No transport response may wait indefinitely for a write callback or drain.
 */
export const MCP_WRITE_TIMEOUT_MS = 30_000;

/** Abort when a disconnected or stalled MCP client cannot drain stdout. */
async function writeResponse(output: Writable, line: string): Promise<void> {
  if (output.destroyed || output.writableEnded) throw new Error("MCP output closed");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drained = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      output.off("drain", onDrain);
      output.off("error", onError);
      output.off("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        output.off("drain", onDrain);
        output.off("close", onClose);
        // Writable can invoke its write callback with an error *before*
        // emitting the stream's error event. Keep the error listener through
        // that event so a failed write cannot crash the MCP process.
        setImmediate(cleanup);
        reject(error);
      } else {
        cleanup();
        resolve();
      }
    };
    const succeed = () => { if (callbackDone && drained) finish(); };
    const onDrain = () => { drained = true; succeed(); };
    const onError = () => finish(new Error("MCP output failed"));
    const onClose = () => finish(new Error("MCP output closed"));
    output.once("error", onError);
    output.once("close", onClose);
    // A custom Writable can emit "drain" synchronously from write().
    // Subscribe before calling write so the event cannot be missed.
    output.once("drain", onDrain);
    timeout = setTimeout(() => {
      finish(new Error("MCP output timed out"));
      // A timed-out Writable may still hold an unfinished OS pipe or a late
      // callback. Destroy it to release resources and suppress late stream
      // errors after session listeners are removed.
      try { output.destroy(); } catch {
        // Preserve the original timeout if a custom Writable misbehaves.
      }
    }, MCP_WRITE_TIMEOUT_MS);
    try {
      const canWrite = output.write(line, (error) => {
        if (error) {
          finish(new Error("MCP output failed"));
          return;
        }
        callbackDone = true;
        succeed();
      });
      drained ||= canWrite;
      // The stream may have closed between write() and listener registration.
      if (output.destroyed || output.writableEnded) onClose();
      else succeed();
    } catch {
      finish(new Error("MCP output failed"));
    }
  });
}

/** No human diagnostics are ever written to the JSON-RPC stdout stream. */
export async function runMcpStdio(
  input: AsyncIterable<Uint8Array> = stdin,
  output: Writable = stdout,
): Promise<void> {
  const decoder = new McpJsonLineDecoder();
  const session = new McpJsonRpcSession();
  // Writable errors can arrive between responses, when writeResponse() has
  // removed its per-write listener. Keep a session listener so such errors
  // cannot become uncaught process-level exceptions.
  let outputFailed = false;
  // Output can disappear while the client leaves stdin open and idle. A plain
  // for-await loop would then wait forever for another input chunk. Race each
  // read against the output failure signal so the session can terminate.
  const outputClosed = Symbol("MCP output closed");
  let signalOutputClosed!: () => void;
  const outputFailure = new Promise<typeof outputClosed>((resolve) => {
    signalOutputClosed = () => resolve(outputClosed);
  });
  const onOutputError = () => {
    outputFailed = true;
    signalOutputClosed();
  };
  output.on("error", onOutputError);
  // A client can close stdout between replies, including immediately before
  // stdin EOF. Treat this as transport failure rather than silent success.
  output.on("close", onOutputError);
  const iterator = input[Symbol.asyncIterator]();
  let inputCompleted = false;
  try {
    if (output.destroyed || output.writableEnded) onOutputError();
    while (true) {
      const next = await Promise.race([iterator.next(), outputFailure]);
      if (next === outputClosed) throw new Error("MCP output failed");
      if (next.done) {
        inputCompleted = true;
        break;
      }
      for (const message of decoder.decode(next.value)) {
        if (outputFailed) throw new Error("MCP output failed");
        const result = session.handle(message);
        if (result === null) continue;
        const line = JSON.stringify(result)
          .replace(/\u0085/g, "\\u0085")
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029") + "\n";
        await writeResponse(output, line);
      }
    }
    decoder.finish();
    if (outputFailed) throw new Error("MCP output failed");
  } finally {
    // Close an unfinished input iterator on any failure, including malformed
    // frames and stalled writes. A pending stdin read must not keep the MCP
    // process alive. Never await a potentially uncooperative iterator.
    if (!inputCompleted) {
      const destroyable = input as AsyncIterable<Uint8Array> & { destroy?: () => void };
      try {
        if (typeof destroyable.destroy === "function") destroyable.destroy();
        else void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        // Do not replace the original transport failure with cleanup errors.
      }
    }
    output.off("error", onOutputError);
    output.off("close", onOutputError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMcpStdio().catch(() => {
    // Never reflect arbitrary input, paths, or exception details into diagnostics.
    stderr.write("SkillGate MCP stdio session terminated\n");
    process.exitCode = 1;
  });
}
