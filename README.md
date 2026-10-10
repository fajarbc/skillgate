# SkillGate

A local runtime for selecting, controlling, and inspecting agent skills.

SkillGate sits between a coding agent and a collection of skills. It keeps the full skill catalog out of the model context, selects a small working set from local project and task signals, and records why each skill was selected.

The project is early. The first milestone is a useful local CLI with deterministic behavior and no required hosted service.

## Goals

- Discover `SKILL.md` files from configurable locations.
- Build a local index without sending the skill catalog to an LLM.
- Detect useful project signals from files and manifests.
- Rank a small set of skills for the current task.
- Explain selection decisions with `skillgate trace`.
- Enforce explicit policies before a skill is exposed or used.
- Keep the core independent of any single coding agent.

## Non-goals

SkillGate is not a skill marketplace, an autonomous coding agent, or a replacement for an agent's native skill system.

## Planned CLI

```text
skillgate scan
skillgate recommend "fix the failing authentication test"
skillgate trace
skillgate doctor
```

The command surface will stay small until the underlying behavior is stable.

## Configuration

Create `skillgate.yaml` in the project root:

```yaml
version: 1
skillRoots:
  - ./skills
candidateLimit: 10
policyPath: ./skillgate.policy.json
adapters:
  - codex
  - claude
adapterOptions:
  codex:
    mode: safe
```

Run `skillgate config --json` to inspect the effective configuration, or use `--config path/to/config.yaml` for an explicit JSON or YAML file. Values are resolved in this order (highest priority first): explicit `--config`, project `skillgate.yaml`, user `~/.config/skillgate/config.yaml`, built-in defaults. Missing keys inherit from lower-priority sources. Skill and policy paths are relative to the configuration file that declares them. `--root` chooses the workspace and default skill root, while `--adapter` chooses which enabled adapter to apply. A nonempty `adapters` list restricts available adapters; an empty list does not restrict them.

`adapterOptions` is an optional map of adapter names to string, finite-number, or boolean settings. Settings merge per adapter and per option key across configuration layers, with the highest-priority specified value winning. These options are passed to the selected adapter through its context; individual adapters may ignore options they do not implement yet. Avoid putting secrets in configuration because `skillgate config` prints effective values as JSON.\n\nInvalid keys, unsupported versions, and invalid values are rejected. If a configured policy file is missing, recommendations fail rather than silently using a permissive policy.

## Design principles

**Local first.** Discovery, filtering, and deterministic ranking should work without a network connection.

**Small context.** Agents should see the skills they are likely to need, not the entire installed catalog.

**Explainable decisions.** A recommendation should include enough evidence to understand why it happened.

**Explicit policy.** Relevance does not imply permission. Policy checks are a separate step.

**Adapter boundaries.** Agent-specific integration belongs behind adapters rather than in the core router.

## Status

Pre-alpha. APIs, configuration, and file formats may change before the first tagged release.

## Development

The initial implementation and contributor documentation are being built on the `development` branch. Changes should arrive through focused pull requests with tests.

## License

Apache-2.0. The license file will be added as part of the repository bootstrap.
