# Remaining Gap Plan

Date: 2026-04-27

This plan closes the remaining gap between the current `langchain-codex` package and a very useful
LangChain/LangGraph chat model integration.

The package is already a solid beta: it implements `BaseChatModel`, invocation, streaming,
structured output, usage metadata, Codex runtime content blocks, custom stream events, thread
resume, safe sandbox defaults, package exports, and experimental LangGraph-compatible
`bindTools()`.

The remaining work is mostly product-grade reliability, clearer capability signaling, and better
LangGraph ergonomics.

## Progress

- PRs 1-4 have been implemented and merged.
- PR 5 is implemented by the real LangGraph examples work.
- PR 6 remains as the next integration-confidence task.

## PR 1: Fix Streaming Metadata

### Problem

Streaming currently appends every Codex item event to `response_metadata.codex.items`. This can
leave duplicate or stale snapshots in the final streamed metadata, unlike non-streaming `turn.items`.

### Scope

- Deduplicate streamed `ThreadItem` values by `item.id` before exposing final
  `response_metadata.codex.items`.
- Keep callback/custom event history unchanged so consumers can still observe every event.
- Add unit tests proving streamed metadata contains the latest item state.

### Acceptance Criteria

- Streaming consumers receive clean final metadata.
- Event consumers still receive every Codex runtime event.
- Non-streaming metadata behavior remains unchanged.

### Changeset

Patch.

## PR 2: LangGraph Thread Continuity

### Problem

Each call starts a new Codex thread by default. This keeps `.batch()` behavior predictable, but
LangGraph users need a clear pattern for persisting and resuming Codex threads across graph turns and
checkpoints.

### Scope

- Add a LangGraph example that stores `response_metadata.codex.threadId` in graph state.
- Consider a small public helper such as `getCodexThreadId(message)` if it removes meaningful
  boilerplate.
- Document concurrency rules for shared Codex threads:
  - stateless model instances start new threads by default;
  - explicit `threadId` resumes a Codex thread;
  - model instances constructed with a default `threadId` should run with `maxConcurrency: 1`;
  - branching graph paths should not mutate the same Codex thread concurrently.
- Add tests around explicit `threadId` usage in a graph loop.

### Acceptance Criteria

- A user can run a graph, checkpoint state, and resume into the same Codex thread intentionally.
- The docs make thread ownership and concurrency rules explicit.

### Changeset

Minor if a new public helper is exported. Otherwise patch or no changeset if the PR is docs-only.

## PR 3: Tighten Capability Signaling

### Problem

`profile.toolCalling: true` is useful for dynamic LangGraph consumers, but the implementation is
prompt-mediated and experimental rather than SDK-native provider tool calling.

### Scope

- Revisit whether `profile.toolCalling` and `profile.toolChoice` should remain `true`.
- If they remain `true`, make the README and API docs explicit that this means experimental
  LangChain-compatible client-side tool-call emulation.
- If they change to `false`, document Codex server-side runtime activity as the primary native tool
  surface through content blocks and stream events.
- Add tests for the chosen profile behavior.

### Acceptance Criteria

- Dynamic LangChain and LangGraph users are not misled into assuming provider-native tool calling.
- Documentation clearly distinguishes:
  - Codex runtime tools executed inside a Codex turn;
  - LangChain client-side tools executed by `ToolNode`;
  - prompt-mediated `bindTools()` compatibility.

### Changeset

Patch unless public profile behavior changes materially. If profile behavior changes, use minor
because dynamic consumers may branch on those flags.

## PR 4: Structured Output Semantics

### Problem

`withStructuredOutput()` accepts options such as `strict` and `jsonMode`, but Codex uses per-turn
`outputSchema`, so OpenAI-style function-calling semantics do not directly apply.

### Scope

- Decide whether `strict` should be rejected, ignored with documentation, or mapped to a Codex-native
  schema behavior if the SDK exposes one.
- Clarify or reject `method: "jsonMode"` if it still maps to Codex `outputSchema`.
- Add tests for:
  - `strict`;
  - `includeRaw`;
  - malformed JSON;
  - Zod validation failure;
  - unsupported methods.

### Acceptance Criteria

- Runtime behavior and docs match exactly.
- Unsupported structured-output modes fail with clear `CodexUnsupportedFeatureError` messages.

### Changeset

Patch.

## PR 5: Real LangGraph Examples

### Problem

Before PR 5, the examples did not show the workflows most LangGraph users will try first. In
particular, `examples/langgraph-agent.ts` was a basic `invoke()` example rather than a graph.

### Scope

- Replace `examples/langgraph-agent.ts` with an actual LangGraph workflow.
- Add or update examples for:
  - `ToolNode` and `toolsCondition`;
  - `createReactAgent` if it remains compatible;
  - thread resume in graph state;
  - streaming content blocks and `streamEvents()`.
- Update stale planning docs so they no longer describe implemented features as future work.

### Acceptance Criteria

- A new user can copy an example and run a useful Codex-backed LangGraph workflow.
- Docs match the current package behavior.

### Changeset

Patch for user-visible docs/examples. No changeset only if the change is strictly unpublished
planning docs.

## PR 6: Integration Confidence

### Problem

The deterministic fake-client tests are strong, but the real Codex integration tests are opt-in and
not yet part of a regular confidence path.

### Scope

- Add a manual or self-hosted CI workflow for `RUN_CODEX_INTEGRATION_TESTS=1`.
- Add a post-publish smoke test that installs the published npm package in a fresh project.
- Keep fake-client unit tests as the fast default suite.

### Acceptance Criteria

- The normal suite remains fast and deterministic.
- Maintainers have a documented path to verify real Codex SDK behavior before or after releases.
- Published-package smoke testing proves the npm artifact can be installed and imported.

### Changeset

No changeset for CI-only work unless package docs or user-visible scripts change.

## Release Readiness Target

After these PRs, `langchain-codex` should be ready to present as a genuinely useful
LangChain/LangGraph chat model for Codex-backed repository automation.

The remaining caveat should be stated plainly: client-side `bindTools()` is experimental until Codex
exposes native JavaScript tool registration or another provider-native tool-calling mechanism.
