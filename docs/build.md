# Build and Packaging Policy

SkillGate maintains an explicit separation between production runtime artifacts and test/development files.

## TypeScript Configurations

- **`tsconfig.json`**: Primary workspace configuration used for IDE support and type-checking the entire codebase (including unit and integration tests) via `npm run typecheck`.
- **`tsconfig.build.json`**: Dedicated production build configuration used by `npm run build`. Extends `tsconfig.json` and excludes `src/**/*.test.ts` so that no compiled test files are emitted to `dist/`.

## Emitted Artifacts and Source Maps

- Emitted JavaScript targets ES2022 with NodeNext module resolution.
- Declarations (`.d.ts`) and source maps (`.js.map`) are generated for all runtime modules in `dist/`.
- The CLI binary `dist/cli.js` preserves its executable shebang (`#!/usr/bin/env node`).

## Package Release Boundary

When publishing or packing the package (`npm pack --dry-run`):
- Only `dist/`, `README.md`, `LICENSE`, and `package.json` are packaged.
- Tests, test fixtures, local traces, and internal development files are excluded.
- The `prepack` script ensures that checks and builds run from a clean state before release.
