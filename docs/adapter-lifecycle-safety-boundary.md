# Filesystem adapter lifecycle safety boundary

SkillGate's Codex and Claude Code adapters expose skills through a plan/apply/cleanup lifecycle. This note records the current safety boundary while issue #28 remains open.

## Ownership and recovery

- `plan` is read-only and reports prospective writes, stale removals, and conflicts.
- `apply` records a pending manifest before changing managed files. SHA-256 digests identify bytes that SkillGate previously wrote or verified, including recovery after an interrupted apply.
- A legacy manifest that has only an ownership marker is readable for migration, but its marker alone does **not** authorize replacement or deletion.
- `cleanup` checks recorded ownership before removal. A user-edited managed file with different bytes must be retained, even when it still has the SkillGate header.
- Explicit `force` is an intentional overwrite option; it is not a substitute for validating ownership during ordinary cleanup.

## Concurrency boundary (important)

A temporary-directory lock serializes **cooperating SkillGate processes** targeting the same adapter root. It does not lock out unrelated processes or another actor with write access to the workspace.

Ownership is checked before a path-based `rename` or `rm`. A non-cooperating writer can replace the destination **after the final check but before the mutation** (time-of-check/time-of-use race). Consequently, SkillGate must **not** claim an unconditional guarantee that it cannot replace or delete user-owned content when arbitrary concurrent writers are present. No amount of rechecking the path alone makes the check and mutation atomic.

Until the issue is resolved, use apply/cleanup only in a workspace without untrusted concurrent filesystem writers. Stop on ownership conflicts; do not use `force` to conceal them. Treat symlink checks and digest checks as defense in depth, not an atomic compare-and-swap.

## Acceptance evidence still needed for #28

1. Run `npm run typecheck` and `npm run test:adapters` on the integration candidate, including Codex and Claude Code shared contracts.
2. Verify that repeated apply is idempotent and that dry-run writes/removals match the subsequent apply under an unchanged workspace.
3. Test legacy marker-only manifests, interrupted pending manifests, edited managed files, stale cleanup, and symlink/path conflicts.
4. Either implement a defensible concurrency mechanism for the supported platforms or explicitly narrow the acceptance guarantee to cooperating writers and obtain review of that boundary.

This document does not declare issue #28 complete.
