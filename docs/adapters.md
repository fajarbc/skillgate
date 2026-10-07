# Agent Adapters

SkillGate uses adapters to translate approved candidate skills into forms expected by specific coding agents. The routing, detection, and policy pipeline remains independent of any single agent.

## Codex Adapter

The Codex adapter exposes approved skills for OpenAI Codex workspaces.

### Written Files

When applied (`--adapter codex`), the adapter writes to the project root:

1. `.codex/skills/<skill-name>/SKILL.md`
   Each approved skill's markdown instructions and frontmatter are copied into individual skill directories.
2. `.codex/skills.json`
   A JSON manifest describing exposed skills, their metadata, capabilities, relevance score, and source path.

### What is Exposed

- Only policy-approved skills are exposed.
- Rejected skills, unselected candidates, and policy-denied skills are excluded.
- No skills or code are executed by the adapter.

## Claude Code Adapter

The Claude Code adapter exposes approved skills for Claude Code agent workspaces.

### Written Files

When applied (`--adapter claude` or `--adapter claude-code`), the adapter writes to the project root:

1. `.claude/skills/<skill-name>/SKILL.md`
   Each approved skill's markdown instructions and frontmatter are copied into individual skill directories.
2. `.claude/skills.json`
   A JSON manifest describing exposed skills, their metadata, capabilities, relevance score, and source path.

### What is Exposed

- Only policy-approved skills are exposed.
- Rejected skills, unselected candidates, and policy-denied skills are excluded.
- No skills or code are executed by the adapter.
