# SkillGate CLI JSON protocol v1 (proposed contract)

Status: **design only — not yet implemented**. This document is the target contract for P0 #31. The current CLI's `--json` output is unversioned and does **not** conform to these envelopes. Consumers must not rely on v1 until the implementation, schemas, fixtures, and tests are merged.

## Invocation and transport

`skillgate <command> --json [options]` emits exactly **one UTF-8 JSON object followed by a newline** on stdout, for success or failure. Diagnostics may go to stderr, but never to JSON stdout. Exit status 0 indicates success; nonzero indicates failure. A caller must inspect both exit status and `ok`.

Supported v1 commands are `scan`, `recommend`, `trace`, `doctor`, and `config`. `plan` and `apply` will join the protocol when their CLI entry points exist. Human-readable CLI output is unaffected by v1.

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
| `recommend` | `task`, `recommendations` | Recommendations must already be policy-filtered; `adapter` summary is optional when an adapter is explicitly requested. |
| `trace` | `trace` | `trace` is a trace record or `null` when none exists; absence is not a transport error. |
| `doctor` | `report` | `report.status === "fail"` returns a nonzero process exit even if a report is successfully produced; a diagnostic failure is represented as `ok: false` with a structured report or error. |
| `config` | `configuration` | Must use the existing sanitized effective configuration, never raw secrets. |
| `plan` (future) | `plan` | Must not mutate the workspace. |
| `apply` (future) | `result` | May mutate only according to the safe adapter lifecycle. |

For v1, these field names and their JSON types are stable. Additional optional fields may be introduced without a version bump. Existing required fields may not be removed or repurposed in v1.

## Large task input via stdin (future)

`skillgate recommend --json --stdin` will accept a **single** UTF-8 JSON object on stdin:

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

Proposed stable error codes: `INVALID_REQUEST`, `UNSUPPORTED_PROTOCOL`, `CONFIGURATION_ERROR`, `POLICY_ERROR`, `ADAPTER_CONFLICT`, and `INTERNAL_ERROR`.

Exit status 0: successful request. Exit status 1: invalid request or command. Exit status 2: configuration or policy error. Exit status 3: adapter conflict or failed operation. Exit status 4: unexpected internal error. These codes are **proposed** and must be validated against existing CLI compatibility before implementation.

## Required conformance tests before release

- One golden JSON fixture and JSON Schema validation for each supported command, including error output.
- Stdout is parseable as one JSON document with no log contamination; stderr is separate.
- Unknown commands, malformed stdin, oversized stdin, unsupported version, and empty task return structured errors and nonzero exits.
- Multiline task text survives stdin without shell quoting.
- Sanitized configuration never leaks secrets.
- Policy-denied skills are absent from recommendation output.
- Existing human output and exit behavior remain compatible unless explicitly documented.

**Implementation status:** No v1 envelope, stdin transport, or schema fixtures are claimed by this document. This is an implementation checklist, not a release announcement.
