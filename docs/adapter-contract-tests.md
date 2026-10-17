# Adapter compatibility tests

Run `npm run test:adapters` for the adapter tests, or `npm run check` for type checking and the full test suite. Pull-request CI runs both, followed by the production build and package inspection.

## Opt in a new filesystem adapter

Add a registration to `src/adapters/contract.test.ts`:

```ts
runAdapterContractSuite({
  label: "Example",
  createAdapter: () => new ExampleAdapter(),
  managedDirectory: ".example",
  expectedAgent: "example",
});
```

The factory supplies a fresh adapter for each test. `managedDirectory` is the adapter's directory relative to the temporary workspace; `expectedAgent` is its canonical identity in result objects. The current contract assumes the shared filesystem layout: `skills/<normalized-id>/SKILL.md` plus an ownership manifest. An adapter using a different integration mechanism will need a separate contract rather than pretending to implement filesystem exposure.

The suite and its `makeSkill`/`writeSkill` fixtures live in `src/adapters/testing/adapter-contract.test.ts`. The `.test.ts` suffix deliberately keeps this test-only module out of the production build. Its small fixture self-test also lets Vitest discover it directly. Every fixture lives under the operating system's temporary directory and is removed after the test, including failed assertions.

## Shared guarantees

Codex and Claude Code run the same tests for deterministic formatting and plans, no output mutation during format/plan, matching plan/apply results, idempotent output and manifest bytes, stale managed-file removal, cleanup, preservation of user-owned content, explicit-force conflict handling, invalid names, normalized-name collisions, traversal containment, symlinked-root rejection, and JSON-serializable result fields. Registry tests cover canonical names and aliases.

`src/adapters/policy-contract.test.ts` exercises the real CLI/router boundary for `codex`, `claude`, and `claude-code`. It verifies that denied names, denied capabilities, and invalid metadata are excluded from both JSON recommendations and exposed files; policy revocation removes old exposure; and invalid policy JSON fails before adapter output is created. Policy filtering belongs to the router, not the adapter interface, so these tests do not mock an already-approved skill list.

When adding an adapter, register its names/aliases and add its CLI target to the policy contract table as well as the shared filesystem suite. Keep adapter-specific behavior tests alongside these contracts. These tests establish a reusable baseline, not a claim that every interruption or concurrent filesystem mutation is covered; ongoing lifecycle hardening remains separate.
