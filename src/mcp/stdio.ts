#!/usr/bin/env node
/** Local MCP stdio transport. Tools remain disabled until #30 policy validation. */
import { once } from "node:events";
import { stdin, stdout, stderr } from "node:process";
import { type Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpJsonLineDecoder } from "./json-line.js";
import { McpJsonRpcSession } from "./json-rpc.js";

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
      if (!output.write(line)) await once(output, "drain");
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
