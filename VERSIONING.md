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

## Preparing a Release

Run the normal checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
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

## Publishing

Publishing should happen from GitHub Actions using npm trusted publishing, not a long-lived npm token.

Manual release workflow:

1. Merge the version PR or commit.
2. Confirm CI is green on `main`.
3. Run the `Release` workflow from GitHub Actions.
4. Confirm the package appears on npm with the expected version.
5. Create a GitHub release for the tag/version.

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
