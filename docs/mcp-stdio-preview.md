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
The tool list is deliberately empty and `tools/call` is rejected until the
read-only discovery, policy enforcement, and approved-skill-read API is
implemented and validated. Do not configure this preview as a functional MCP
skill integration yet.

The full MCP acceptance criteria, end-to-end integration tests, and package
entrypoint remain pending. No GitHub Actions workflow changes are required.
