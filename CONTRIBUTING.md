# Contributing

Thanks for taking the time to contribute.

## Before opening a change

For non-trivial behavior changes, open an issue first. Bug fixes with a clear reproduction can go directly to a pull request.

Keep pull requests focused. Avoid mixing refactors with behavior changes unless the refactor is necessary for the change.

## Local checks

Use Node.js 20 or newer.

```sh
npm ci
npm run check
npm run build
npm run smoke:cli
```

Tests should cover new routing, parsing, or policy behavior. Changes to command output should include a fixture or focused assertion when practical.

## Cross-platform CI

Every pull request to `main` or `development` runs the full typecheck, test suite,
production build, built-CLI smoke test, and package dry-run on this six-job matrix:

| Operating system | Node.js versions |
| --- | --- |
| Ubuntu (`ubuntu-latest`) | 20, 24 |
| macOS (`macos-latest`) | 20, 24 |
| Windows (`windows-latest`) | 20, 24 |

Node 20 exercises the declared minimum engine; Node 24 adds a newer runtime
without multiplying jobs for every intermediate version. Matrix failures do not
cancel the other platforms, so a failure remains attributable to its OS/runtime.

`npm run smoke:cli` requires a prior build. It launches the compiled CLI through
Node (portable across shells), from a path containing spaces, Unicode, `#`, and
`%`. It checks the version, JSON scan/recommend/trace/doctor/config output, and
both built-in adapters including repeated apply. Existing adapter tests exercise
plan/apply/cleanup in temporary workspaces on every matrix entry.

JSON keys, values, and ranking must remain consistent across platforms. Filesystem
paths intentionally use native separators and temporary-directory prefixes;
runtime versions and trace timestamps/IDs also vary. Path tests cover Windows
reserved device names on every platform, plus backslash/mixed-separator traversal
on Windows. Use `node:path` rather than literal `/` in filesystem assertions.

Tests get an empty temporary `HOME`/`USERPROFILE` and `XDG_CONFIG_HOME` per test
file, and the built-CLI smoke test sets its own temporary home. They must not read
or alter a contributor's real global agent or SkillGate configuration. Explicit
user-configuration precedence tests still supply their own fixture files.

Symlink safety tests run normally, including on Windows when privileges permit.
Only Windows symlink-creation errors `EPERM`, `EACCES`, or `ENOSYS` skip the affected
case with a reason; assertion failures and other filesystem errors still fail.
Linux and macOS always exercise these defenses. Enable Windows Developer Mode or
use an account allowed to create symbolic links to run those cases locally.

## Commit messages

Use short, imperative commit messages. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:` are preferred.

## Pull requests

Explain the problem, the approach, and how the change was tested. Link the issue when one exists.
