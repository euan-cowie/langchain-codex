# Repository Instructions

## Changesets

Before committing or opening a PR, check whether the change affects the published package.

Add a changeset when a change affects runtime behavior, public API, package docs, dependencies, or
other user-visible package behavior:

```bash
npm run changeset
npm run changeset:status
```

Use:

- `minor` for new user-facing features or breaking changes before `1.0.0`
- `patch` for bug fixes
- no changeset only for test-only, CI-only, formatting-only, or unpublished planning-doc changes

Do not create the final commit or open the PR until `npm run changeset:status` reports the intended
package bump, or the PR clearly falls into a no-changeset category.
