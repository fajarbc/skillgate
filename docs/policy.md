# Policy Evaluation and Configuration

SkillGate evaluates candidate skills against security policies before exposing them to agents.

## Precedence and Discovery

When evaluating policy for a workspace root, SkillGate checks configuration files in order of precedence:

1. `.skillgate/policy.json` (highest precedence, project-local state)
2. `skillgate.policy.json` (workspace configuration)

If neither file exists, SkillGate falls back to safe default behavior (`defaultAction: "allow"` with empty allow/deny lists).

## Explicit Failures

If a policy configuration file exists but cannot be read, contains malformed JSON, specifies unsupported fields, or contains invalid types:

- SkillGate stops evaluation immediately and produces a clear, concise error.
- A malformed higher-precedence file (`.skillgate/policy.json`) is never silently bypassed in favor of a lower-precedence file.
- CLI commands return a non-zero exit code (1).
- Error messages identify the problematic file and field without echoing sensitive file content.

## Schema

```json
{
  "defaultAction": "allow" | "deny",
  "allowedSkills": ["string"],
  "deniedSkills": ["string"],
  "allowedCapabilities": ["string"],
  "deniedCapabilities": ["string"]
}
```
