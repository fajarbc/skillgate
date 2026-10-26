# Experimental SkillGate MCP stdio transport

This is a **protocol-only preview**, not a usable SkillGate tool server yet.
It progresses P0 #30 without exposing arbitrary filesystem reads or bypassing
skill-root and policy authorization.

After building with `npm run build`, a local MCP client can launch:

```sh
node dist/mcp/stdio.js
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

Its text content is JSON containing `protocolVersion`,
`skillToolsAvailable: false`, and `filesystemAccess: "disabled"`.
It does not inspect the workspace, environment, configuration, or skills.
Unknown tool names, non-object arguments, and unexpected status arguments
return JSON-RPC invalid-params errors. The discovery, policy enforcement,
and approved-skill-read APIs remain unavailable pending #30 authorization
and integration tests. Do not configure this preview as a functional MCP
skill integration yet.

The full MCP acceptance criteria, end-to-end integration tests, and package
entrypoint remain pending. No GitHub Actions workflow changes are required.
