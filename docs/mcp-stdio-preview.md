# Experimental SkillGate MCP stdio transport

This is a **protocol-only preview**, not a usable SkillGate tool server yet.
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
The tool list currently exposes **only** `skillgate/status`. It is a
filesystem-free, read-only diagnostic with an empty-object input schema:

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

It does not inspect the workspace, environment, configuration, or skills.
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

The package now exposes a separate `skillgate-mcp` executable in addition to
`skillgate`. It is **still a status-only preview**: do not configure it as a
functional skill integration. After `npm run build`, run `npm run smoke:mcp`
to exercise the actual built entrypoint, framing, rejection, stdout/stderr
isolation, and no-workspace-write behavior. This smoke is not a substitute for
full Vitest/typecheck or adversarial authorization tests.

The full MCP acceptance criteria and end-to-end integration tests remain
pending. No GitHub Actions workflow changes are required.
