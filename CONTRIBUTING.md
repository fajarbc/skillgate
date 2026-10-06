# Contributing

Thanks for taking the time to contribute.

## Before opening a change

For non-trivial behavior changes, open an issue first. Bug fixes with a clear reproduction can go directly to a pull request.

Keep pull requests focused. Avoid mixing refactors with behavior changes unless the refactor is necessary for the change.

## Local checks

Use Node.js 20 or newer.

```sh
npm install
npm run check
npm run build
```

Tests should cover new routing, parsing, or policy behavior. Changes to command output should include a fixture or focused assertion when practical.

## Commit messages

Use short, imperative commit messages. Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `chore:` are preferred.

## Pull requests

Explain the problem, the approach, and how the change was tested. Link the issue when one exists.
