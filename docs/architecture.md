# Architecture

SkillGate is split into a small set of boundaries so routing logic does not depend on one agent.

## Pipeline

1. **Discovery** finds skills and reads their metadata.
2. **Detection** collects local project and task signals.
3. **Ranking** reduces the catalog to a small candidate set.
4. **Policy** decides which candidates may be exposed.
5. **Adapters** translate the approved set into an agent-specific form.
6. **Trace** records inputs, scores, policy decisions, and context estimates.

The first implementation will be deterministic and local. Semantic ranking can be added later as an optional provider.

## Core constraints

- Reading a repository must not execute repository code.
- Network access must not be required for discovery or deterministic ranking.
- A skill's relevance score must not bypass policy.
- Trace output must avoid secret values and raw environment variables.
- Agent integrations depend on the core; the core does not depend on agent integrations.

## Initial modules

```text
src/
  cli.ts
  discovery/
  detection/
  ranking/
  policy/
  trace/
  adapters/
```

These directories will be introduced as their behavior is implemented. Empty architecture is deliberately avoided.
