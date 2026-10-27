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
Notifications do not produce responses, including malformed no-ID JSON objects
(such as an initialized notification with an invalid JSON-RPC version or method).
These objects cannot complete the handshake. Malformed requests **with IDs**
receive JSON-RPC Invalid Request errors; non-object JSON input remains an
Invalid Request. Invalid framing terminates the session; a generic diagnostic
is written to stderr, never stdout.

The server currently supports `initialize` (protocol version
`2025-06-18`), `notifications/initialized`, `ping`, and `tools/list`.
The tool list exposes `skillgate/status`, `skillgate/rank-metadata`, and
`skillgate/evaluate-metadata-policy`.
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

None of these tools inspects the workspace, environment, configuration, or skill files.

`skillgate/rank-metadata` calls the **same ranking core** as the CLI, but only
on metadata explicitly supplied by the MCP client. It does not discover skills,
load policy, authorize skill use, or read instructions. Its output explicitly
sets `policyEvaluated: false` and `filesystemAccess: "disabled"`; callers MUST
NOT interpret a positive score as policy approval. Input is limited to a
nonempty task (at most 4,096 Unicode code points), up to 64 client-supplied
skills with opaque IDs, names (at most 128 code points), and descriptions
(at most 512 code points), and an optional result limit of 1–8. Unpaired
UTF-16 surrogates are rejected in these text fields; non-whitespace task and
name values are required. Returned skill names additionally reject C0/C1
terminal controls, DEL, and Unicode bidirectional formatting controls (including Arabic Letter Mark U+061C and left-to-right/right-to-left marks U+200E/U+200F). The
same restriction is advertised in the name's JSON Schema and enforced at
runtime; task text may still contain newlines. Paths, root selectors,
unexpected fields, and duplicate IDs are rejected. The input and output JSON schemas are closed, and the output carries
an independent `schemaVersion: "1"`.

Example after completing the MCP handshake:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skillgate/rank-metadata","arguments":{"task":"react component","skills":[{"id":"react","name":"React Tools","description":"Build components"}],"limit":1}}}
```

The `skillgate/evaluate-metadata-policy` tool uses the **same policy evaluation core**
as the CLI, but receives both the policy and skill metadata from the MCP client.
It does **not** load the server's effective policy or grant access to a skill.
The v1 result explicitly includes `policySource: "client-supplied"`,
`authorizationGranted: false`, and `filesystemAccess: "disabled"` alongside
`decision` and `reason`. A reported `allow` is only a hypothetical result
under the caller's policy, **never permission to read a skill**.

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"skillgate/evaluate-metadata-policy","arguments":{"name":"Build API","capabilities":["network"],"policy":{"defaultAction":"allow","deniedCapabilities":["network"]}}}}
```

The policy preview accepts a nonblank skill name (at most 128 Unicode code
points), at most 16 capability strings, and an explicit policy object with
optional default action and allow/deny lists (at most 32 patterns per list).
All names, capabilities, and patterns reject unpaired surrogates, C0/C1
controls, DEL, and bidirectional formatting controls. The schema rejects
unknown fields and caller-supplied filesystem paths; all policy inputs are
bounded. Neither the preview nor the MCP server evaluates this caller-supplied
policy as an authorization grant.

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
the handshake state. Initialization protocol/client identity strings must be
nonblank, well-formed Unicode without C0/C1 controls, DEL, or
bidirectional formatting controls; invalid identities receive `-32602`
and do not advance initialization. String request IDs are also checked for
these unsafe characters before they can be echoed in JSON-RPC responses;
invalid IDs produce `-32600` with a null response ID.
Standard MCP object-valued `_meta` request metadata is
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
isolation, no-workspace-write behavior, and strict schema-subset validation of
actual `skillgate/status`, `skillgate/rank-metadata`, and
`skillgate/evaluate-metadata-policy` outputs. The subset
validator rejects unsupported JSON Schema keywords and checks nested closed
objects, array limits, integer bounds, and Unicode code-point string lengths.
It is **not** an independent JSON Schema 2020-12 implementation or a substitute
for full Vitest/typecheck, adversarial authorization tests, or independent
validation of built outputs before release.

The full MCP acceptance criteria and end-to-end integration tests remain
pending. No GitHub Actions workflow changes are required.
