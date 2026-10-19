# Skill metadata

SkillGate reads YAML frontmatter from `SKILL.md`. Discovery preserves the fields below in its metadata model; filesystem adapters continue to copy the original `SKILL.md` bytes, so forwarding does not reserialize or drop frontmatter fields.

```yaml
---
name: focused-tests
description: Run focused tests for a change
license: Apache-2.0
compatibility: Requires Node.js 20 or newer
metadata:
  author: example
  version: "1.0"
allowed-tools: Read Bash(npm:test)
capabilities:
  - filesystem.read
host-setting:
  enabled: true
---
```

## Supported fields

| Field | Accepted value | SkillGate behavior |
| --- | --- | --- |
| `name`, `description` | Required non-empty strings | Trimmed; used by deterministic routing. Names also participate in policy and managed destination identity, as before. |
| `license`, `compatibility` | Optional non-empty strings | Preserved verbatim; not used in ranking or policy. |
| `metadata` | Optional string-to-string mapping | Preserved; quote numeric-looking values such as versions. |
| `allowed-tools` | Optional non-empty string | Preserved experimental portable field; does **not** grant SkillGate capabilities or override policy. |
| `capabilities` | Optional array of non-empty strings | SkillGate-specific policy input. Entries are trimmed. An empty array is valid. Malformed values invalidate the skill rather than silently dropping permission declarations. |
| Other keys | Finite, acyclic JSON-compatible data | Preserved in the model's `extensions` map; never merged into routing, policy, or adapter options. |

Absent optional fields remain absent. Existing two-field skills produce the same metadata and routing results. The parser does not enforce host-specific name/length conventions; its supported subset is a data-preservation contract, not a guarantee that every host accepts every skill.

## Extension safety and diagnostics

An input field literally named `extensions` is itself an untrusted extension, not a way to inject fields into the trusted metadata model. Reserved keys such as `__proto__` are stored as inert own properties. Cyclic aliases, non-finite numbers, and YAML-only collection types are rejected. Metadata is limited to 32 nesting levels and 10,000 traversed values, with YAML alias expansion additionally bounded. Files are discovered without executing their contents.

`skillgate doctor` warns when extension fields are present. Its diagnostic includes skill paths and field names, not extension values. The warning means SkillGate does not interpret those fields; it does not assert that the destination host rejects them. Other machine-facing metadata output can include extension values, so do not store secrets in skill frontmatter.

Host-specific validation and per-adapter plan diagnostics are follow-up work under issue #50. No host permission field is translated into SkillGate policy in this change. Adapters preserve unknown frontmatter in the copied source, but their actual host interpretation remains outside this compatibility guarantee.
