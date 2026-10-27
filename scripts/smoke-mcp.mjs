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
    { jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "skillgate/evaluate-metadata-policy", arguments: {
        name: "Build API", capabilities: ["network"],
        policy: { defaultAction: "allow", deniedCapabilities: ["network"] },
      } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "skillgate/evaluate-metadata-policy", arguments: {
        name: "Build API", policy: {}, root: "/etc/passwd",
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
  assert.equal(lines.length, 9, "exactly eight JSON-RPC response lines");
  const responses = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[1].id, "list\u2028separator");
  assert.ok(lines[1].includes("\\u2028"), "line separators must be escaped on the wire");
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name),
    ["skillgate/status", "skillgate/rank-metadata", "skillgate/evaluate-metadata-policy"]);
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
  const policyTool = responses[1].result.tools[2];
  assert.equal(policyTool.inputSchema.additionalProperties, false);
  assert.equal(policyTool.outputSchema.additionalProperties, false);
  validate(policyTool.inputSchema, messages[7].params.arguments);
  assert.throws(() => validate(policyTool.inputSchema, messages[8].params.arguments),
    /unexpected property/);
  const policyResult = responses[6].result.structuredContent;
  validate(policyTool.outputSchema, policyResult);
  assert.equal(policyResult.policySource, "client-supplied");
  assert.equal(policyResult.authorizationGranted, false);
  assert.equal(policyResult.filesystemAccess, "disabled");
  assert.equal(policyResult.decision, "deny");
  assert.deepEqual(JSON.parse(responses[6].result.content[0].text), policyResult);
  assert.equal(responses[7].error.code, -32602);
  assert.ok(!ok.stdout.includes("/etc/passwd"), "invalid path must not be echoed to stdout");
  // Invalid client identity cannot complete initialization; a later valid
  // handshake must recover without unsolicited output or diagnostics.
  const invalidClient = {
    ...messages[0], id: 11,
    params: { ...messages[0].params,
      clientInfo: { name: "bad" + String.fromCharCode(0) + "name", version: "1" } },
  };
  const blankProtocol = {
    ...messages[0], id: 12,
    params: { ...messages[0].params, protocolVersion: " " },
  };
  const identityFrames = [invalidClient, blankProtocol, messages[0],
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 13, method: "tools/list" }];
  const identityRun = invoke(identityFrames.map((value) => JSON.stringify(value) + String.fromCharCode(10)).join(""));
  assert.equal(identityRun.stderr, "");
  const identityResponses = identityRun.stdout.trimEnd().split(String.fromCharCode(10)).map((line) => JSON.parse(line));
  assert.equal(identityResponses.length, 4);
  assert.equal(identityResponses[0].error.code, -32602);
  assert.equal(identityResponses[1].error.code, -32602);
  assert.equal(identityResponses[2].result.protocolVersion, "2025-06-18");
  assert.ok(Array.isArray(identityResponses[3].result.tools));
  assert.ok(!identityRun.stdout.includes("bad"), "invalid identity must not be reflected");
  for (const bad of [Buffer.from([0xff, 10]), Buffer.from("{invalid}\n"),
    Buffer.from('{"jsonrpc":"2.0","method":"ping"}')]) {
    const rejected = invoke(bad, 1);
    assert.equal(rejected.stdout, "", "invalid framing must never leak into stdout");
    assert.equal(rejected.stderr, "SkillGate MCP stdio session terminated\n");
  }
  // The built transport must not echo controls from request IDs or skill names.
  const hostileFrames = [
    messages[0], messages[1],
    { jsonrpc: "2.0", id: "bad\u202e", method: "ping" },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "skillgate/rank-metadata", arguments: { task: "react", skills: [
        { id: "react", name: "React\u001b[31m", description: "React components" },
      ] },
    } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: {
      name: "skillgate/rank-metadata", arguments: { task: "react", skills: [
        { id: "react", name: "React Tools", description: "React components" },
      ] },
    } },
  ];
  const hostileRun = invoke(hostileFrames.map((value) =>
    JSON.stringify(value) + "\n").join(""));
  assert.equal(hostileRun.stderr, "");
  const hostileResponses = hostileRun.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(hostileResponses.length, 4);
  assert.equal(hostileResponses[1].id, null);
  assert.equal(hostileResponses[1].error.code, -32600);
  assert.equal(hostileResponses[2].error.code, -32602);
  assert.equal(hostileResponses[3].result.structuredContent.ranked[0].name, "React Tools");
  assert.ok(!hostileRun.stdout.includes("\u202e"));
  assert.ok(!hostileRun.stdout.includes("\u001b"));
  // Exercise policy preview rejection through the actual built MCP process.
  // JSON.stringify encodes lone surrogates as escapes, which remain valid JSON
  // but must not be accepted as policy metadata after parsing.
  const invalidPolicyArguments = [
    { name: "Build" + String.fromCharCode(0x202e) + " API", policy: {} },
    { name: "Build API", capabilities: [String.fromCharCode(0xd800)], policy: {} },
    { name: "Build API", policy: { deniedSkills: ["Build" + String.fromCharCode(0x0085)] } },
  ];
  // JSON Schema regex patterns can reject bidi/C1 controls. Lone escaped
  // surrogates require the runtime's explicit well-formed-Unicode check;
  // the strict schema-subset validator does not implement that rule.
  for (const args of [invalidPolicyArguments[0], invalidPolicyArguments[2]]) {
    assert.throws(() => validate(policyTool.inputSchema, args),
      /pattern mismatch/, "advertised policy schema must reject display controls");
  }
  const policyFrames = [
    messages[0], messages[1],
    ...invalidPolicyArguments.map((args, index) => ({
      jsonrpc: "2.0", id: index + 20, method: "tools/call",
      params: { name: "skillgate/evaluate-metadata-policy", arguments: args },
    })),
    { jsonrpc: "2.0", id: 23, method: "tools/call",
      params: { name: "skillgate/evaluate-metadata-policy", arguments: messages[7].params.arguments } },
  ];
  const policyRun = invoke(policyFrames.map((value) =>
    JSON.stringify(value) + "\n").join(""));
  assert.equal(policyRun.stderr, "");
  const policyResponses = policyRun.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(policyResponses.length, 5);
  for (let i = 1; i <= 3; i++) {
    assert.equal(policyResponses[i].error.code, -32602);
    assert.equal(policyResponses[i].id, i + 19);
  }
  assert.equal(policyResponses[4].result.structuredContent.authorizationGranted, false);
  assert.equal(policyResponses[4].result.structuredContent.decision, "deny");
  assert.ok(!policyRun.stdout.includes(String.fromCharCode(0x202e)));
  assert.ok(!policyRun.stdout.includes(String.fromCharCode(0x0085)));
  assert.ok(!policyRun.stdout.includes("\\ud800"));

  // Unicode directional marks are not C0/C1 controls, but can still spoof
  // client identifiers or names reflected in JSON-RPC responses.
  const directionalFrames = [
    messages[0], messages[1],
    { jsonrpc: "2.0", id: "spoof" + String.fromCharCode(0x200f), method: "ping" },
    { jsonrpc: "2.0", id: 31, method: "tools/call", params: {
      name: "skillgate/rank-metadata", arguments: { task: "react", skills: [
        { id: "react", name: "React" + String.fromCharCode(0x200e), description: "" },
      ] },
    } },
    { jsonrpc: "2.0", id: 32, method: "tools/call", params: {
      name: "skillgate/evaluate-metadata-policy", arguments: {
        name: "Build" + String.fromCharCode(0x061c), policy: {},
      },
    } },
    { jsonrpc: "2.0", id: 33, method: "tools/call", params: {
      name: "skillgate/status", arguments: {},
    } },
  ];
  const directionalRun = invoke(directionalFrames.map((message) =>
    JSON.stringify(message) + "\n").join(""));
  assert.equal(directionalRun.stderr, "");
  const directionalResponses = directionalRun.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(directionalResponses.length, 5);
  assert.equal(directionalResponses[1].id, null);
  assert.equal(directionalResponses[1].error.code, -32600);
  assert.equal(directionalResponses[2].error.code, -32602);
  assert.equal(directionalResponses[3].error.code, -32602);
  assert.equal(directionalResponses[4].result.structuredContent.filesystemAccess, "disabled");
  for (const code of [0x061c, 0x200e, 0x200f]) {
    assert.ok(!directionalRun.stdout.includes(String.fromCharCode(code)));
  }

  assert.deepEqual(await readdir(workspace), [], "preview must not mutate the workspace");
  console.log("Built MCP entrypoint smoke passed (framing, status, metadata ranking, policy preview, denial, stdout isolation).");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
