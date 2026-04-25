# Tasks

Future work to bring `langchain-codex` closer to ChatOpenAI-style ergonomics while preserving Codex's local-agent semantics.

## ChatOpenAI Parity

- [ ] Investigate LangChain `bindTools()` support.
  - Decide whether any Codex-compatible subset can map cleanly to LangChain tool calling.
  - Do not claim provider tool-call support unless outputs can be represented as real LangChain tool calls.

- [ ] Explore prompt-mediated tool calling.
  - Prototype only behind an explicit opt-in flag.
  - Treat this as emulation, not native tool calling.
  - Document that prompt tricks are less reliable than provider-native tool calls.

- [ ] Implement a LangGraph checkpointer integration.
  - Store Codex `threadId` in checkpoint metadata.
  - Support resuming graph execution into the same Codex thread.
  - Define concurrency rules for graph branches that share a Codex thread.

- [ ] Improve multimodal input support.
  - Add remote image URL support only if Codex SDK supports it directly or if safe local materialization is implemented.
  - Add base64 image support only with explicit temp-file handling, size limits, and cleanup.
  - Keep unsupported audio, video, and generic files rejected with clear errors.

- [ ] Improve streaming fidelity.
  - Track Codex SDK streaming changes.
  - Emit token-like deltas when Codex provides incremental text.
  - If Codex only emits item-level updates, continue documenting best-effort chunking rather than promising exact token streaming.

## LangChain Integration Polish

- [ ] Add richer LangSmith metadata.
- [ ] Add configurable Codex metadata verbosity.
- [ ] Emit custom callback events for Codex command execution, file changes, MCP calls, web search, and todo updates.
- [ ] Add compatibility tests against latest `@langchain/core`.
- [ ] Investigate `initChatModel` or provider registration hooks if LangChain exposes a stable third-party integration path.

## Codex SDK Coverage

- [ ] Track new Codex SDK options and expose stable ones in `ChatCodexSDKFields`.
- [ ] Add compatibility tests for Codex SDK minor releases.
- [ ] Add examples for `workspace-write`, approval policies, web search, and additional directories.
- [ ] Add more precise auth, CLI, and sandbox error normalization as real errors are observed.

## Package Quality

- [ ] Add API documentation generated from TypeScript declarations.
- [ ] Add a self-hosted/manual workflow for real Codex integration tests.

## Release Automation

- [x] Add an automated version PR workflow using Changesets.
- [x] Create git tags automatically after successful npm publish.
- [x] Create GitHub releases automatically from the matching changelog section.
- [ ] Add a post-publish smoke test that installs the just-published version of `langchain-codex` from npm in a fresh temp project.
