# Agent Adapters

SkillGate uses adapters to translate approved candidate skills into forms expected by specific coding agents. The routing, detection, and policy pipeline remains independent of any single agent.

## Adapter Lifecycle

Every agent adapter implements a safe, idempotent lifecycle:

1. **`plan(context, options)`**:
   Computes intended file writes and removals without modifying the workspace. Identifies potential conflicts when unmanaged user-owned files already exist at target paths.
2. **`apply(context, options)`**:
   Performs the plan idempotently. Adds an ownership marker (`<!-- Managed by SkillGate. Do not edit directly. -->`) to managed skills and updates `skills.json`. Removes stale SkillGate-managed files from previous runs while preserving user-created content.
3. **`cleanup(context, options)`**:
   Removes only files owned and tracked by SkillGate in `skills.json` and leaves user-created files untouched.

### Conflict Detection & Safety

- Destination files not tracked in the previous manifest or lacking the ownership marker are treated as **user-owned content**.
- Adapters refuse to overwrite user-owned content, throwing `AdapterConflictError` unless explicitly forced via `force: true`.

## Codex Adapter

The Codex adapter exposes approved skills for OpenAI Codex workspaces.

### Written Files

When applied (`--adapter codex`), the adapter manages:

1. `.codex/skills/<skill-identifier>/SKILL.md`
   Each approved skill's instructions with SkillGate ownership header.
2. `.codex/skills.json`
   A JSON manifest describing exposed skills, managed files, capabilities, relevance score, and source path.

## Claude Code Adapter

The Claude Code adapter exposes approved skills for Claude Code agent workspaces.

### Written Files

When applied (`--adapter claude` or `--adapter claude-code`), the adapter manages:

1. `.claude/skills/<skill-identifier>/SKILL.md`
   Each approved skill's instructions with SkillGate ownership header.
2. `.claude/skills.json`
   A JSON manifest describing exposed skills, managed files, capabilities, relevance score, and source path.
