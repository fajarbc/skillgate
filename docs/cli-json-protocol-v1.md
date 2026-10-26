# SkillGate CLI JSON protocol v1 (proposed contract)

Status: **implementation in progress on the #31 feature branch; not released**. Versioned `--json` envelopes and bounded stdin transport are wired into the CLI on this branch. Schema fixtures, full repository tests, and review are still pending. Consumers must not rely on v1 until the changes are validated and merged.

## Invocation and transport

`skillgate <command> --json [options]` emits exactly **one UTF-8 JSON object followed by a newline** on stdout, for success or failure. Diagnostics may go to stderr, but never to JSON stdout. Exit status 0 indicates success; nonzero indicates failure. A caller must inspect both exit status and `ok`.

Supported v1 commands are `scan`, `recommend`, `trace`, `doctor`, and `config`. `plan` and `apply` will join the protocol only after #28 lifecycle safety is accepted. Until then, `recommend --json --adapter <name>` fails closed with `ADAPTER_CONFLICT` and exit status 3 **before writing to the workspace**; it must not silently fall back to an unsafe apply. Human-readable CLI behavior is unchanged. JSON `recommend` deliberately does **not** persist `.skillgate/trace.json` while #28 lifecycle safety is unresolved: the current trace writer follows predictable paths and can overwrite user-owned symlink targets. JSON `trace` can read an existing trace written by the human CLI, but it is not updated by JSON recommendations. This is a temporary read-only machine-mode safety boundary, not a promise that human-mode trace persistence is race-free.

### Success envelope

```json
{
  "protocolVersion": 1,
  "command": "scan",
  "ok": true,
  "data": {
    "root": "/workspace",
    "skills": [],
    "signals": []
  }
}
```

### Error envelope

```json
{
  "protocolVersion": 1,
  "command": "recommend",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "recommend requires nonempty task text"
  }
}
```

The `command` field contains the requested command name, or `null` when command parsing fails before a command is available. The error `message` is safe to display but **not** stable for programmatic matching; `code` is stable within protocol v1. Never include stack traces, secret environment values, or raw configuration credentials in error payloads.

## Command data contracts

| Command | Required `data` fields | Notes |
| --- | --- | --- |
| `scan` | `root`, `skills`, `signals` | Same discovery/detection core as the human CLI. |
| `recommend` | `task`, `recommendations` | Recommendations must already be policy-filtered. Machine-mode `--adapter` is rejected until #28 lifecycle safety is accepted; the optional `adapter` response field is reserved for a future safe implementation. |
| `trace` | `trace` | `trace` is a trace record or `null` when none exists; absence is not a transport error. |
| `doctor` | `report` | A failed report returns exit status 2 and `ok: false` with `error.code: CONFIGURATION_ERROR` and `data.report` for diagnostics. |
| `config` | `configuration` | Must use the existing sanitized effective configuration, never raw secrets. |
| `plan` (future) | `plan` | Must not mutate the workspace. |
| `apply` (future) | `result` | May mutate only according to the safe adapter lifecycle. |

For v1, these field names and their JSON types are stable. Additional optional fields may be introduced without a version bump. Existing required fields may not be removed or repurposed in v1.

## Large task input via stdin (feature branch)

`skillgate recommend --json --stdin` accepts a **single** UTF-8 JSON object on stdin, bounded to 1 MiB:

```json
{
  "protocolVersion": 1,
  "task": "Investigate the failing test\nThen propose a focused patch",
  "context": {
    "paths": ["src/adapters/filesystem-lifecycle.ts"]
  }
}
```

`task` must be a nonempty string. `context.paths` is optional and advisory; it never grants filesystem access outside configured roots. The stdin reader must have a fixed byte limit and reject malformed JSON, unsupported protocol versions, oversized requests, and conflicting positional task text with structured errors. The default CLI remains positional unless `--stdin` is present. Stdin must not be interpreted as shell commands.

## Error codes and exit behavior

Stable v1 error codes: `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `CONFIGURATION_ERROR`, `POLICY_ERROR`, `ADAPTER_CONFLICT`, and `INTERNAL_ERROR`.

Exit status 0: successful request. Exit status 1: invalid request or command. Exit status 2: configuration, policy, or failed doctor checks. Exit status 3: adapter conflict or failed operation. Exit status 4: unexpected internal error. Human-readable CLI exit codes remain unchanged.

## Schemas and golden fixtures

The feature branch includes `schemas/cli-json-v1.schema.json`, `schemas/cli-json-stdin-v1.schema.json`, and eight golden examples in `fixtures/cli-json-v1/`. `npm run test:protocol` runs a dependency-free fixture check covering the schema keywords used by these files; `npm test` runs it before Vitest. This limited check is **not** a substitute for full JSON Schema 2020-12 validation of real CLI outputs before release.

## Required conformance tests before release

- One golden JSON fixture and JSON Schema validation for each supported command, including error output.
- Stdout is parseable as one JSON document with no log contamination; stderr is separate.
- Unknown commands, malformed stdin, oversized stdin, unsupported version, and empty task return structured errors and nonzero exits.
- Multiline task text survives stdin without shell quoting.
- Sanitized configuration never leaks secrets.
- Policy-denied skills are absent from recommendation output.
- Existing human output and exit behavior remain compatible unless explicitly documented.

**Implementation status:** v1 envelope routing and strict bounded stdin parsing have been committed to the #31 feature branch. Schema fixtures and full CLI/Vitest validation are still outstanding; this is not a release announcement.
