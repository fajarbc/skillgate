# Roadmap

This roadmap describes direction rather than release promises.

## M0 — Foundation

- CLI entry point and command contract
- strict TypeScript build
- unit test setup
- CI for type checking and tests
- contribution and security documentation

## M1 — Local discovery

- discover `SKILL.md` files from configured roots
- parse and validate skill metadata
- inspect common project manifests without executing project code
- stable machine-readable scan output

## M2 — Deterministic routing

- task and project signal model
- deterministic candidate ranking
- configurable candidate/context budgets
- human-readable recommendation reasons

## M3 — Trace and policy

- persisted local trace records
- context/token estimates
- allow/deny policy evaluation
- secret-safe diagnostic output

## M4 — Agent adapters

- Codex adapter
- Claude Code adapter
- adapter contract and fixtures

## Later

Optional semantic ranking, richer permission manifests, more agent adapters, benchmarks, and signed/trusted skill sources should be driven by real usage rather than added to the core prematurely.
