# Experimental SkillGate MCP stdio transport

This is a **filesystem-free preview**, not a complete SkillGate skill server yet.
It progresses P0 #30 without exposing arbitrary filesystem reads or bypassing
skill-root and policy authorization.

After building with `npm run build`, a local MCP client can launch:

```sh
node dist/mcp/stdio.js
# Or, after installing the package: skillgate-mcp
```

The server reads strict UTF-8, newline-delimited JSON-RPC messages from stdin
(maximum 1 MiB per message), and writes only JSON-RPC responses to stdout.
Notifications do not produce responses. Invalid framing terminates the session;
a generic diagnostic is written to stderr, never stdout.

The server currently supports `initialize` (protocol version
`2025-06-18`), `notifications/initialized`, `ping`, and `tools/list`.
The tool list exposes `skillgate/status` and `skillgate/rank-metadata`.
The status tool is a filesystem-free diagnostic with an empty-object input schema:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skillgate/status","arguments":{}}}
```

Its text content is JSON containing `schemaVersion: "1"`,
`protocolVersion`, `skillToolsAvailable: false`, and
`filesystemAccess: "disabled"`. The same object is returned in
`structuredContent` for clients supporting structured MCP tool results;
`tools/list` advertises a closed `outputSchema` with these four required
fields. The text response remains available for older clients. This status
schema version is separate from the MCP transport protocol version.

Neither tool inspects the workspace, environment, configuration, or skill files.

`skillgate/rank-metadata` calls the **same ranking core** as the CLI, but only
on metadata explicitly supplied by the MCP client. It does not discover skills,
load policy, authorize skill use, or read instructions. Its output explicitly
sets `policyEvaluated: false` and `filesystemAccess: "disabled"`; callers MUST
NOT interpret a positive score as policy approval. Input is limited to a
nonempty task (at most 4,096 UTF-16 code units), up to 64 client-supplied
skills with opaque IDs, names, and descriptions, and an optional result limit
of 1–8. Paths, root selectors, unexpected fields, and duplicate IDs are
rejected. The input and output JSON schemas are closed, and the output carries
an independent `schemaVersion: "1"`.

Example after completing the MCP handshake:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skillgate/rank-metadata","arguments":{"task":"react component","skills":[{"id":"react","name":"React Tools","description":"Build components"}],"limit":1}}}
```

This preview ranks client-provided metadata, **not discovered or policy-approved
skills**. It is not a substitute for the full authorized MCP APIs in #30.
The JSON-RPC envelope itself is also closed to `jsonrpc`, `id`, `method`,
and optional `params`. Extra top-level fields (including a misplaced `_meta`,
workspace root, or path) are rejected before a request is processed. Such
fields on `notifications/initialized` cannot complete the handshake; malformed
notifications remain silent. MCP metadata must be inside `params._meta`.

Unknown tool names, non-object arguments, unexpected status arguments, and
unrecognized `tools/list` or `tools/call` parameter fields return JSON-RPC
invalid-params errors. `initialize` accepts only `protocolVersion`, `capabilities`,
`clientInfo`, and optional object-valued `_meta` at the top level of its
parameters. `ping` accepts no operational parameters, only optional object-valued
`_meta`. Unexpected fields and malformed metadata fail closed without changing
the handshake state. Standard MCP object-valued `_meta` request metadata is
accepted; malformed metadata is rejected. The
`notifications/initialized` handshake likewise accepts only optional
object-valued `_meta` parameters: unexpected fields and malformed metadata
cannot transition the session to ready. The discovery, policy enforcement,
and approved-skill-read APIs remain unavailable pending #30 authorization
and integration tests. Do not configure this preview as a functional MCP
skill integration yet.

The package exposes a separate `skillgate-mcp` executable in addition to
`skillgate`. It is **still a preview without skill-file access**: do not configure
it as a functional skill integration. After `npm run build`, run `npm run smoke:mcp`
to exercise the actual built entrypoint, framing, rejection, stdout/stderr
isolation, and no-workspace-write behavior. This smoke is not a substitute for
full Vitest/typecheck or adversarial authorization tests.

The full MCP acceptance criteria and end-to-end integration tests remain
pending. No GitHub Actions workflow changes are required.
