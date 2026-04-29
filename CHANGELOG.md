# Changelog

## 0.6.0

### Minor Changes

- aa2a7c5: Add an experimental `runtime: "app-server"` backend that drives Codex through `codex app-server`, with a direct Codex CLI dependency, JSON-RPC stdio process management, streamed event normalization, usage mapping, conservative approval handling, and `ChatCodexSDK.close()` for process cleanup.

## 0.5.0

### Minor Changes

- 85668c7: Harden prompt-mediated `bindTools()` tool calling with strict per-tool arg validation, one default repair retry, trace metadata, and explicit compatibility opt-outs.

## 0.4.0

### Minor Changes

- 7b099f2: Add `getCodexThreadId()` and document a checkpointed LangGraph thread-resume pattern.

### Patch Changes

- 2b1f546: Deduplicate streamed Codex metadata items so final stream metadata reports the latest state for each runtime item.
- c886e86: Clarify that tool profile support means experimental prompt-mediated LangChain `bindTools()` compatibility, not native Codex SDK tool registration.
- 5029c68: Add runnable LangGraph examples for ToolNode loops, createReactAgent, thread resume, streaming Codex content blocks/events, and explicit Codex reasoning effort configuration.
- 60b1cb8: Reject unsupported `withStructuredOutput()` modes with clear errors and document the Codex `outputSchema` semantics.

## 0.3.0

### Minor Changes

- c4ec7e9: Add experimental prompt-mediated `bindTools()` support that returns LangChain tool calls from Codex structured output.
- af21862: Expose a conservative LangChain model profile and verify experimental tool calls against LangGraph ToolNode workflows.
- 00e6e49: Surface Codex runtime activity through LangChain content blocks and custom stream events.

### Patch Changes

- 52d8c4f: Remove stale v0.1 wording from published README guidance and unsupported-feature errors.

## 0.2.0

### Minor Changes

- d6edf13: Drop Node.js 18 support and require Node.js 20 or later.

  Add a Node 20/22 CI matrix, package smoke test, trusted publishing hardening, and standard open source project docs and templates.

### Patch Changes

- eeb2515: Remove the `zod-to-json-schema` dependency and use Zod v4's native JSON Schema conversion for structured output.
- 8ff2754: Add top-level package types metadata, export `package.json`, and document the ESM-only module format.

## 0.1.0

- Initial development release.
