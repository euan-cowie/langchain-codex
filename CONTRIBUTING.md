# Contributing

Thanks for helping improve `langchain-codex`.

## Development Setup

Requirements:

- Node.js 20 or later.
- npm.
- Local Codex auth only if you want to run integration tests.

Install dependencies:

```bash
npm install
```

Run the normal checks:

```bash
npm run changeset:check
npm run changeset:status
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
npm run smoke:package
```

Integration tests are opt-in because they require local Codex auth:

```bash
RUN_CODEX_INTEGRATION_TESTS=1 npm run test:integration
```

## Branch Flow

Use short-lived branches from `main`:

```bash
git checkout main
git pull
git checkout -b my-change
```

Open a pull request once checks pass locally. CI must pass before merge.

## Changesets

This repo uses Changesets for package versions and changelog entries.

Add a changeset when a PR affects the published package:

```bash
npm run changeset
npm run changeset:status
```

Usually:

- `patch` for bug fixes.
- `minor` for new features or breaking changes before `1.0.0`.
- `major` for breaking changes after `1.0.0`.

No changeset is normally needed for test-only refactors, CI-only changes, formatting, or unpublished planning docs.

CI runs `npm run changeset:check` on pull requests. It fails package-impacting changes that do not
include a changeset file.

## Pull Request Expectations

PRs should include:

- a clear summary
- tests or a reason tests are not needed
- a changeset when runtime behavior, public API, package docs, dependencies, or user-visible behavior changes
- documentation updates when behavior or supported usage changes

Keep changes scoped. Avoid unrelated refactors in feature or bug-fix PRs.

## Release Process

Release details live in `VERSIONING.md` and `RELEASE_CHECKLIST.md`.
