# Release Checklist

Status: pre-release  
Target package: `langchain-codex`  
Primary export: `ChatCodexSDK`

## Before First Public Push

- [ ] Review package metadata in `package.json`.
- [ ] Confirm repository URL is correct.
- [ ] Confirm license and copyright.
- [ ] Confirm README examples match the current API.
- [ ] Commit the initial implementation.
- [ ] Create the GitHub repository under the intended owner.
- [ ] Push `main`.
- [ ] Confirm GitHub Actions CI runs on the first push.

## Local Verification

Run before tagging or publishing:

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run pack:dry-run
```

After the initial commit has been pushed to `main`, also run:

```bash
npm run changeset:status
```

Current known local note:

- `npm pack --dry-run` may fail if the local npm cache under `~/.npm` has ownership issues. Use a temporary cache if needed:

```bash
npm_config_cache=/tmp/langchain-codex-npm-cache npm run pack:dry-run
```

## Integration Verification

Run manually on a machine with local Codex auth:

```bash
RUN_CODEX_INTEGRATION_TESTS=1 npm run test:integration
```

Check:

- [ ] `ChatCodexSDK.invoke()` works against a real repo.
- [ ] streaming returns assistant chunks.
- [ ] structured output works with a simple schema.
- [ ] returned `response_metadata.codex.threadId` can resume a thread.
- [ ] auth and git-repo failures produce useful errors.

## npm Name

Confirm immediately before publishing:

```bash
npm view langchain-codex name version
```

Expected result before first publish:

- `404 Not Found`

Fallback if the name is taken:

- `@euan/langchain-codex`

## Publish

Version the release from pending changesets:

```bash
npm run version
```

Review `CHANGELOG.md`, `package.json`, and `package-lock.json`, then merge the version commit.

Publish from GitHub Actions using the `Release` workflow. The workflow runs `npm run release`, which delegates to `changeset publish`.

Post-publish checks:

- [ ] Package page renders README.
- [ ] Tarball contains only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`.
- [ ] Install works in a fresh temp project.
- [ ] Basic example works from the published package.
- [ ] Create a GitHub release for `v0.1.0`.

## Security Notes

Current audit note:

- `npm audit` reports moderate issues through `@langchain/core -> uuid`.
- This package uses `@langchain/core` as a peer/dev dependency.
- Do not force a transitive override unless LangChain publishes or recommends a compatible fix.

## v0.1 Release Scope

Included:

- `ChatCodexSDK`
- `.invoke()`
- `.stream()`
- inherited `.batch()`
- Codex-native `outputSchema`
- custom `withStructuredOutput()`
- explicit thread resume support
- examples
- unit tests
- opt-in integration test
- CI and manual release workflow

Not included:

- LangChain `bindTools()`
- browser support
- Python support
- direct OAuth token handling
- direct private Codex backend calls
