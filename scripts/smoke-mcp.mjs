import assert from "node:assert/strict";
import { validate } from "./validate-cli-json-fixtures.mjs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(pkg.bin["skillgate-mcp"], "./dist/mcp/stdio.js");
const entry = resolve(root, pkg.bin["skillgate-mcp"]);
const workspace = await mkdtemp(join(tmpdir(), "skillgate-mcp-smoke-"));
try {
  function invoke(input, expectedStatus = 0) {
    const result = spawnSync(process.execPath, [entry], {
      cwd: workspace,
      input,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, HOME: workspace, USERPROFILE: workspace },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stderr);
    return result;
  }
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "list\u2028separator", method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "skillgate/status", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "filesystem/read", arguments: { path: "/etc/passwd" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "skillgate/rank-metadata", arguments: { task: "react", skills: [
        { id: "react", name: "React Tools", description: "Build components" },
      ] } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "skillgate/rank-metadata", arguments: {
        task: "react", skills: [], path: "/etc/passwd",
      } } },
  ];
  // Malformed no-id notification objects must not create unsolicited JSON-RPC
  // responses, including before and during initialization.
  const malformedNotifications = [
    { jsonrpc: "1.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: 42 },
  ];
  const wireMessages = [
    ...malformedNotifications, messages[0], ...malformedNotifications, ...messages.slice(1),
  ];
  const ok = invoke(wireMessages.map((value) => JSON.stringify(value) + "\n").join(""));
  assert.equal(ok.stderr, "", "successful MCP sessions must not log diagnostics");
  assert.ok(ok.stdout.endsWith("\n"));
  const lines = ok.stdout.split("\n");
  assert.equal(lines.length, 7, "exactly six JSON-RPC response lines");
  const responses = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[1].id, "list\u2028separator");
  assert.ok(lines[1].includes("\\u2028"), "line separators must be escaped on the wire");
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name),
    ["skillgate/status", "skillgate/rank-metadata"]);
  const rankTool = responses[1].result.tools[1];
  assert.equal(rankTool.inputSchema.additionalProperties, false);
  assert.equal(rankTool.outputSchema.additionalProperties, false);
  assert.equal(rankTool.outputSchema.properties.schemaVersion.const, "1");
  assert.equal(rankTool.outputSchema.properties.policyEvaluated.const, false);
  // Validate the actual built process contract, not only a hand-picked field.
  // This is a strict keyword subset, not a full JSON Schema 2020-12 validator.
  validate(rankTool.inputSchema, messages[5].params.arguments);
  assert.throws(() => validate(rankTool.inputSchema, messages[6].params.arguments),
    /unexpected property/);
  validate(rankTool.inputSchema, { task: "🛡".repeat(4096), skills: [] });
  assert.throws(() => validate(rankTool.inputSchema,
    { task: "🛡".repeat(4097), skills: [] }), /too long/);
  assert.equal(responses[2].result.structuredContent.filesystemAccess, "disabled");
  validate(responses[1].result.tools[0].outputSchema, responses[2].result.structuredContent);
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text),
    responses[2].result.structuredContent);
  assert.equal(responses[3].error.code, -32602);
  const ranked = responses[4].result.structuredContent;
  assert.equal(ranked.policyEvaluated, false);
  assert.equal(ranked.filesystemAccess, "disabled");
  validate(rankTool.outputSchema, ranked);
  assert.throws(() => validate(rankTool.outputSchema, { ...ranked, policyEvaluated: true }),
    /constant mismatch/);
  assert.throws(() => validate(rankTool.outputSchema, { ...ranked, secret: "unexpected" }),
    /unexpected property/);
  assert.deepEqual(ranked.ranked.map((skill) => skill.id), ["react"]);
  assert.deepEqual(JSON.parse(responses[4].result.content[0].text), ranked);
  assert.equal(responses[5].error.code, -32602);
  assert.ok(!ok.stdout.includes("/etc/passwd"), "invalid path must not be echoed to stdout");
  for (const bad of [Buffer.from([0xff, 10]), Buffer.from("{invalid}\n"),
    Buffer.from('{"jsonrpc":"2.0","method":"ping"}')]) {
    const rejected = invoke(bad, 1);
    assert.equal(rejected.stdout, "", "invalid framing must never leak into stdout");
    assert.equal(rejected.stderr, "SkillGate MCP stdio session terminated\n");
  }
  assert.deepEqual(await readdir(workspace), [], "preview must not mutate the workspace");
  console.log("Built MCP entrypoint smoke passed (framing, status, metadata ranking, denial, stdout isolation).");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
