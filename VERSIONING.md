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

When `main` has merged changesets ready to publish, run the normal checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
npm run smoke:package
```

After the repository has an initial `main` history, check pending release intent:

```bash
npm run changeset:status
```

Then consume pending changesets:

```bash
npm run version
```

This updates:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`

Review the generated changelog and version bump before merging.

Commit the version changes:

```bash
git add package.json package-lock.json CHANGELOG.md .changeset
git commit -m "Version 0.1.1"
git push
```

## Publishing

Publishing should happen from GitHub Actions using npm trusted publishing, not a long-lived npm token.

Manual release workflow:

1. Merge or push the version commit to `main`.
2. Confirm CI is green on `main`.
3. Run the `Release` workflow from GitHub Actions.
4. Confirm the package appears on npm with the expected version.
5. Create and push the git tag for the exact version commit.
6. Create a GitHub release from that tag.

The release workflow runs:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run release
```

`npm run release` delegates to `changeset publish`.

Fallback manual publish:

```bash
npm publish
```

Only use the fallback when the GitHub release workflow or npm trusted publishing is not ready.

## Tagging and GitHub Releases

The GitHub tag must point to the exact commit whose `package.json` version was published to npm.

Example for `0.1.1`:

```bash
git checkout main
git pull
git rev-parse HEAD
cat package.json | jq -r .version

git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1

gh release create v0.1.1 \
  --title "v0.1.1" \
  --notes-file /tmp/langchain-codex-v0.1.1-notes.md
```

The release notes file should contain only the changelog section for that version, not the whole changelog.

Do not move published tags unless a release was created against the wrong commit and no users could have reasonably consumed it yet.

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
- The `Release` workflow can publish through `changeset publish`.
- GitHub tags and releases are created manually.

Target state:

- A version PR is opened automatically when changesets land on `main`.
- Merging the version PR triggers publish.
- The release workflow creates the git tag after successful npm publish.
- The release workflow creates a GitHub release using the matching changelog section.
- The workflow verifies the published package with a fresh install smoke test.

Implementation tasks for that target state are tracked in `TASKS.md`.
