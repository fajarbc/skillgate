#!/usr/bin/env node
/** Local MCP stdio transport. Tools remain disabled until #30 policy validation. */
import { stdin, stdout, stderr } from "node:process";
import { type Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpJsonLineDecoder } from "./json-line.js";
import { McpJsonRpcSession } from "./json-rpc.js";

/** Abort when a disconnected MCP client cannot drain stdout. Waiting for drain
 * alone can hang indefinitely if the writable closes while backpressured.
 */
async function writeResponse(output: Writable, line: string): Promise<void> {
  if (output.destroyed || output.writableEnded) throw new Error("MCP output closed");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drained = false;
    const cleanup = () => {
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
    try {
      const canWrite = output.write(line, (error) => {
        if (error) {
          finish(new Error("MCP output failed"));
          return;
        }
        callbackDone = true;
        succeed();
      });
      drained = canWrite;
      if (!canWrite && !settled) output.once("drain", onDrain);
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
  for await (const chunk of input) {
    for (const message of decoder.push(chunk)) {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMcpStdio().catch(() => {
    // Never reflect arbitrary input, paths, or exception details into diagnostics.
    stderr.write("SkillGate MCP stdio session terminated\n");
    process.exitCode = 1;
  });
}
