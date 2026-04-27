# Chat Model Parity Roadmap

Date: 2026-04-26

Status update: this roadmap is historical. The adapter now includes Codex content blocks,
`streamEvents()` custom events, a model profile, Codex `outputSchema` structured output semantics,
experimental prompt-mediated `bindTools()` compatibility, and documented LangGraph thread resume
examples. Remaining work is tracked in `REMAINING_GAP_PLAN.md`.

This document defines the next implementation steps for bringing `langchain-codex` closer to the
ergonomics of `ChatOpenAI` and `ChatAnthropic`, while preserving Codex's local-agent execution
model.

## Parity Goal

The goal is not exact API equivalence with `ChatOpenAI` or `ChatAnthropic`. Codex is not a plain
remote chat-completions provider: it controls a local agent runtime through the Codex CLI and can run
commands, apply patches, call MCP tools, search the web, and maintain persisted threads.

The goal is therefore:

- Match the LangChain chat model contract where Codex can do so honestly.
- Expose Codex-specific behavior through standard LangChain surfaces where possible.
- Avoid claiming client-side tool-calling support until the adapter can return real
  `AIMessage.tool_calls` that LangChain agents can execute correctly.

## Current Capability Snapshot

| Capability                | Current state                                                    | Parity target                                                                                                            |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Chat model interface      | Implemented via `BaseChatModel`.                                 | Keep stable and add compatibility coverage.                                                                              |
| Invocation                | Implemented with `thread.run()`.                                 | Keep aligned with LangChain input/output expectations.                                                                   |
| Streaming                 | Text deltas, Codex content blocks, and custom callback events.    | Keep documenting Codex's item/event-based streaming model.                                                               |
| Token usage               | Mapped into `usage_metadata` and `tokenUsage`.                   | Keep; add cached/reasoning detail in metadata where useful.                                                              |
| Structured output         | Implemented through Codex `outputSchema`; unsupported modes reject clearly. | Expand schema support where practical.                                                                             |
| Tool calling              | Experimental prompt-mediated `bindTools()` compatibility.        | Keep documenting that this is not native provider tool calling.                                                          |
| Server-side tool activity | Exposed through content blocks, metadata, and custom events.      | Continue aligning new Codex item types with LangChain surfaces.                                                          |
| Multimodal input          | Local images only.                                               | Add safe URL/base64 materialization only if warranted.                                                                   |
| Model profile             | Implemented.                                                     | Keep capability signaling accurate as behavior evolves.                                                                  |
| LangGraph state           | Documented checkpoint/resume pattern with `getCodexThreadId()`.  | Keep examples aligned with LangGraph releases.                                                                           |

## Phase 1: Surface Codex Runtime Events

This is the highest-value next PR because it makes Codex feel like a first-class LangChain model
without misrepresenting tool calling.

### Implementation Steps

1. Add `src/content_blocks.ts` or similar.
2. Convert Codex `ThreadItem` values to LangChain v1 content blocks.
3. In `_generate()`, construct `AIMessage` with `contentBlocks` instead of only a string when useful.
4. Set `response_metadata.output_version = "v1"` for messages whose `content` is v1 content blocks.
5. Preserve the plain final text as `generation.text` and `message.text`.
6. In `_streamResponseChunks()`, emit non-text Codex events through `AIMessageChunk` content blocks
   and/or `runManager.handleCustomEvent()`.
7. Keep `includeCodexItems` as the raw escape hatch for consumers that need exact SDK payloads.

### Suggested Item Mapping

| Codex item                           | LangChain representation                        | Notes                                                                   |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `agent_message`                      | `text`                                          | Preserve current text behavior.                                         |
| `reasoning`                          | `reasoning`                                     | Use Codex's summary text; do not expose hidden chain-of-thought.        |
| `command_execution` started/updated  | `server_tool_call` or `server_tool_call_chunk`  | Tool name: `codex_shell`; args include command and status.              |
| `command_execution` completed/failed | `server_tool_call_result`                       | Include stdout/stderr aggregate, exit code, and status.                 |
| `mcp_tool_call` started/updated      | `server_tool_call` or `server_tool_call_chunk`  | Tool name can be `${server}.${tool}`; args are the MCP arguments.       |
| `mcp_tool_call` completed/failed     | `server_tool_call_result`                       | Include result content or error message.                                |
| `web_search`                         | `server_tool_call` plus optional `non_standard` | Codex item currently carries query; preserve provider-specific details. |
| `file_change`                        | `non_standard` or `server_tool_call_result`     | Preserve path, kind, and status.                                        |
| `todo_list`                          | `non_standard`                                  | Useful in UIs and traces, not model text.                               |
| `error`                              | `non_standard` and metadata                     | Keep visible, but do not turn into assistant prose.                     |

### Custom Callback Events

Emit stable event names so LangGraph and LangSmith users can stream progress:

- `codex.thread.started`
- `codex.turn.started`
- `codex.command_execution.started`
- `codex.command_execution.updated`
- `codex.command_execution.completed`
- `codex.file_change.completed`
- `codex.mcp_tool_call.started`
- `codex.mcp_tool_call.updated`
- `codex.mcp_tool_call.completed`
- `codex.web_search.completed`
- `codex.todo_list.updated`
- `codex.error`

### Tests

Add unit tests with fake Codex stream events for:

- Final message includes v1 content blocks for text, reasoning, command execution, and MCP calls.
- Streaming still concatenates assistant text correctly.
- Streaming emits custom events for non-text Codex items.
- `includeCodexItems: false` suppresses raw SDK items but not standard content blocks.
- Failed command/MCP/error items map to error status without losing the final model error behavior.

### Acceptance Criteria

- Existing `invoke()` and `stream()` examples still work.
- Consumers can inspect `message.contentBlocks` for Codex runtime activity.
- `streamEvents()` can show command/MCP/web/todo progress without parsing `response_metadata`.
- Raw Codex SDK items remain available when requested.

## Phase 2: Add a Conservative Model Profile

LangChain 1.1 model profiles let apps dynamically inspect model capabilities. Add a `profile` getter
to `ChatCodexSDK`.

### Suggested Profile

```ts
override get profile() {
  return {
    structuredOutput: true,
    imageInputs: true,
    imageUrlInputs: false,
    audioInputs: false,
    videoInputs: false,
    reasoningOutput: true,
    toolCalling: false,
    toolChoice: false,
  };
}
```

### Notes

- Keep `toolCalling: false` while `bindTools()` throws.
- Keep `imageUrlInputs: false` because the current adapter only supports local image paths.
- Do not advertise `maxInputTokens` or `maxOutputTokens` unless the adapter has a reliable source
  for the active Codex model.

### Tests

- Unit test that `model.profile` exposes the expected conservative capabilities.
- README snippet showing how a LangGraph or middleware user can inspect the profile.

## Phase 3: Structured Output Polish

The current structured-output implementation is one of the strongest parity areas, but it should be
tightened before expanding other API surfaces.

### Implementation Steps

1. Decide how `strict` should behave.
   - If Codex `outputSchema` has no separate strict mode, either document `strict` as accepted but
     Codex-native, or reject unsupported strict configurations explicitly.
   - Avoid silently implying OpenAI tool strictness semantics.
2. Add tests for:
   - `includeRaw: true`
   - malformed JSON
   - Zod validation failure
   - JSON Schema passthrough
   - unsupported `method: "functionCalling"`
3. Investigate support for LangChain Standard Schema objects.
4. Document that `method: "jsonSchema"` is the recommended method for Codex.

### Acceptance Criteria

- `withStructuredOutput()` behavior is explicit for `jsonSchema`, `jsonMode`, `functionCalling`,
  `includeRaw`, and `strict`.
- Documentation matches runtime behavior exactly.

## Phase 4: Improve Streaming Fidelity

Codex streaming is item/event based, while ChatOpenAI and ChatAnthropic expose token-like streaming.
The adapter should make the difference clear while improving the useful stream surface.

### Implementation Steps

1. Keep current text-delta diffing for `agent_message`.
2. Add content-block streaming for reasoning and server-side tool events.
3. Ensure final empty chunk carries usage metadata and response metadata.
4. Avoid promising token-level streaming unless Codex SDK exposes true token deltas.

### Tests

- Repeated `item.updated` events do not duplicate text.
- Non-prefix text replacement still emits a coherent fallback delta.
- Final chunk contains usage metadata.
- Custom event emission works under `model.streamEvents()`.

## Phase 5: LangGraph Thread Resume Pattern

Codex threads are persisted and resumable. LangGraph users need a clear way to store and restore the
Codex `threadId`.

### Implementation Steps

1. Add a documented helper or example for extracting `response_metadata.codex.threadId`.
2. Add an example with a LangGraph checkpointer where thread ID is stored in state or metadata.
3. Document concurrency rules:
   - stateless model instances start new Codex threads by default;
   - explicit `threadId` resumes a thread;
   - a model constructed with default `threadId` should use `maxConcurrency: 1`;
   - branching graph paths should not mutate the same Codex thread concurrently.

### Acceptance Criteria

- A user can run a graph, persist a checkpoint, and resume into the same Codex thread.
- The README clearly warns about shared-thread concurrency.

## Phase 6: Multimodal Expansion

Do this after the event/content-block work unless a user has an immediate need.

### Implementation Steps

1. Track Codex SDK input support.
2. If remote URLs are still unsupported by SDK, add opt-in URL materialization only with:
   - explicit enable flag;
   - max size;
   - MIME validation;
   - temp-file cleanup;
   - timeout;
   - clear security docs.
3. If base64 images are supported through materialization, apply the same limits.
4. Keep audio, video, and generic files rejected until there is real SDK support.

### Acceptance Criteria

- Existing local-image behavior remains stable.
- Unsupported media produce clear errors.
- Any materialized files are cleaned up reliably.

## Phase 7: Tool Calling Investigation

This should come after Codex server-side tool activity is represented correctly.

### Decision Gate

Only implement `bindTools()` if the adapter can satisfy LangChain's actual client-side tool-calling
contract:

- Bound tool schemas influence the model call.
- The output can contain real `AIMessage.tool_calls`.
- Tool calls have stable IDs, names, and parsed args.
- LangChain agents can execute the calls and feed back `ToolMessage` results.
- A second model invocation can use those `ToolMessage` results correctly.

### Implemented Outcome

- `bindTools()` provides experimental prompt-mediated compatibility with LangChain client-side tool
  calls.
- Codex server-side tool activity is exposed separately through content blocks and stream events.
- Docs state that this is not native Codex SDK provider tool registration.
- `profile.toolCalling` and `profile.toolChoice` are true because compatibility is covered by
  LangGraph `ToolNode` and `createReactAgent` tests.

## Phase 8: Package and Docs Polish

### Implementation Steps

1. Add README sections for:
   - model profile;
   - content blocks;
   - `streamEvents()`;
   - Codex server-side tools vs LangChain client-side tools;
   - LangGraph thread resume.
2. Add API docs generated from TypeScript declarations.
3. Add compatibility tests against latest `@langchain/core`.
4. Add a manual or self-hosted workflow for real Codex integration tests.
5. Add a post-publish smoke test that installs the just-published npm package.

## Suggested PR Order

1. `feat: surface Codex events as LangChain content blocks`
2. `feat: add ChatCodexSDK model profile`
3. `docs: document Codex server-side tools and streamEvents`
4. `test: expand structured output and streaming coverage`
5. `docs: add LangGraph thread resume example`
6. `feat: add safe image materialization` if needed
7. `research: evaluate client-side bindTools compatibility`

## Source Notes

Sources checked on 2026-04-26:

- LangChain `ChatOpenAI` integration:
  https://docs.langchain.com/oss/javascript/integrations/chat/openai
- LangChain `ChatAnthropic` integration:
  https://docs.langchain.com/oss/javascript/integrations/chat/anthropic
- LangChain models guide:
  https://docs.langchain.com/oss/javascript/langchain/models
- LangChain OpenAI tools integration:
  https://docs.langchain.com/oss/javascript/integrations/tools/openai
- OpenAI Codex SDK:
  https://developers.openai.com/codex/sdk

Local files used as implementation references:

- `src/chat_codex_sdk.ts`
- `src/messages.ts`
- `src/structured_output.ts`
- `src/metadata.ts`
- `src/types.ts`
- `TASKS.md`
- `FINDINGS.md`
