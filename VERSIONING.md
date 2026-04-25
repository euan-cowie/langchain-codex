# Versioning and Releases

This package uses SemVer, Changesets, and npm trusted publishing.

## Version Policy

`langchain-codex` starts at `0.1.0`.

Before `1.0.0`:

- `0.1.x`: backwards-compatible fixes only.
- `0.2.0`, `0.3.0`, etc.: new features or breaking changes.
- Breaking changes are allowed in `0.x`, but they must be documented clearly in the changelog.

After `1.0.0`:

- Patch: backwards-compatible bug fixes.
- Minor: backwards-compatible features.
- Major: breaking public API or behavior changes.

## When to Add a Changeset

Add a changeset for changes that affect users of the published npm package:

- public API changes
- runtime behavior changes
- bug fixes users care about
- dependency compatibility changes
- new supported examples
- README changes that document new or changed package behavior

No changeset is normally needed for:

- internal test refactors
- CI-only changes
- formatting
- unpublished planning docs
- typo fixes that do not affect package behavior

## Adding a Changeset

For a user-facing change:

```bash
npm run changeset
```

Choose the bump type:

- `patch` for bug fixes.
- `minor` for backwards-compatible features.
- `major` only after `1.0.0`; before `1.0.0`, use a minor bump for breaking changes unless there is a deliberate reason to do otherwise.

Write the summary as release-note text. It should make sense to someone reading the changelog.

## Git Flow

Use a simple trunk-based flow:

1. Create a short-lived branch from `main`.
2. Make the change.
3. Add a changeset when the change affects the published package.
4. Run local checks.
5. Open a PR.
6. Merge to `main` after CI passes.

Example:

```bash
git checkout main
git pull
git checkout -b remove-unused-dependency

npm run changeset
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
npm run smoke:package

git add -A
git commit -m "Remove unused dependency"
git push -u origin remove-unused-dependency
```

Avoid long-lived release branches unless the project grows enough to need backports.

## Preparing a Release

When a PR with changesets is merged to `main`, the `Version Packages` workflow opens or updates a
Changesets version PR. That PR consumes pending changesets and updates:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`

Review the generated changelog and version bump before merging the version PR.

If the workflow needs to be run manually, use:

```bash
npm run version
```

Then commit the generated version changes to a PR.

Before publishing, confirm `main` is green:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
npm run smoke:package
```

You can also inspect pending release intent locally:

```bash
npm run changeset:status
```

## Publishing

Publishing should happen from GitHub Actions using npm trusted publishing, not a long-lived npm token.

Manual release workflow:

1. Merge or push the version commit to `main`.
2. Confirm CI is green on `main`.
3. Run the `Release` workflow from GitHub Actions.
4. Confirm the package appears on npm with the expected version.
5. Confirm the matching GitHub tag and release were created.

The release workflow runs:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run release
npm run release:github
```

`npm run release` delegates to `changeset publish`.
`npm run release:github` creates `vX.Y.Z` from the workflow commit and uses the matching changelog
section as the GitHub release notes.
The publish step sets `NPM_CONFIG_PROVENANCE=true` so npm can attach provenance metadata from the
trusted GitHub Actions run.

Fallback manual publish:

```bash
npm publish
```

Only use the fallback when the GitHub release workflow or npm trusted publishing is not ready.

## Tagging and GitHub Releases

The GitHub tag must point to the exact commit whose `package.json` version was published to npm.

The `Release` workflow creates the tag and GitHub release automatically after a successful npm
publish. The helper can be run locally if the workflow published npm successfully but release
creation failed:

```bash
git checkout main
git pull
GH_TOKEN=... npm run release:github
```

The release notes should contain only the changelog section for that version, not the whole
changelog.

Do not move published tags unless a release was created against the wrong commit and no users could have reasonably consumed it yet.

## Dependabot

Dependabot checks npm dependencies and GitHub Actions weekly. Dependency update PRs must pass the
same CI checks as normal contributor PRs before merging.

## Branch Protection

Protect `main` in GitHub repository settings. Require pull requests and these required status
checks before merge:

- `test (20)`
- `test (22)`

Keep the required check names in sync with `.github/workflows/ci.yml`.

## npm Trusted Publishing Setup

On npmjs.com, configure trusted publishing for:

- package: `langchain-codex`
- owner/repo: `euan-cowie/langchain-codex`
- workflow: `.github/workflows/release.yml`

Trusted publishing uses short-lived OIDC credentials from GitHub Actions and avoids storing npm tokens in repository secrets.

## First Publish Checklist

- [ ] Confirm `npm view langchain-codex name version` returns `404 Not Found`.
- [ ] Confirm package name in `package.json` is `langchain-codex`.
- [ ] Confirm `.changeset/config.json` has `"access": "public"`.
- [ ] Confirm README examples import from `langchain-codex`.
- [ ] Run `npm run pack:dry-run`.
- [ ] Publish through the GitHub Actions `Release` workflow.

## Automation Plan

Current state:

- Changesets manages version bumps and changelog updates.
- CI verifies lint, typecheck, tests, build, and package dry-run.
- Dependabot opens npm and GitHub Actions update PRs.
- The `Version Packages` workflow opens Changesets version PRs.
- The `Release` workflow publishes through `changeset publish`.
- The `Release` workflow creates the git tag and GitHub release after successful npm publish.

Target state:

- Merging the version PR triggers publish automatically after CI is green.
- The workflow verifies the published package with a fresh install smoke test.

Implementation tasks for that target state are tracked in `TASKS.md`.
