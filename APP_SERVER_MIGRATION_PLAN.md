# Codex App Server Migration Plan

Date: 2026-04-28

## Decision

Move `langchain-codex` toward `codex app-server` as the primary Codex runtime.
Keep the current TypeScript Codex SDK path as a compatibility fallback until the
App Server backend reaches behavioral parity and has enough integration coverage.

The reason is product-fit, not implementation inertia. A LangChain/LangGraph
chat model benefits most from a runtime that exposes durable threads, explicit
turn lifecycle, high-fidelity streaming, interruption, approvals, model
discovery, and server-side tool events. OpenAI documents App Server as the
rich-client integration surface for Codex, while the Codex SDK remains the
simpler path for CI, automation, and internal workflows.

Sources:

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/sdk
- https://openai.com/index/unlocking-the-codex-harness/

## Target Architecture

Introduce an internal runtime boundary:

```ts
interface CodexRuntime {
  startThread(options?: CodexRuntimeThreadOptions): CodexRuntimeThread;
  resumeThread(id: string, options?: CodexRuntimeThreadOptions): CodexRuntimeThread;
}

interface CodexRuntimeThread {
  id: string | null;
  run(input: CodexRuntimeInput, options?: CodexRuntimeTurnOptions): Promise<CodexRuntimeTurn>;
  runStreamed(
    input: CodexRuntimeInput,
    options?: CodexRuntimeTurnOptions,
  ): Promise<{ events: AsyncGenerator<CodexRuntimeEvent> }>;
}
```

Then support two implementations during migration:

- `sdk`: current `@openai/codex-sdk` behavior.
- `app-server`: new implementation backed by a long-lived `codex app-server`
  process over stdio JSONL.

The public ChatModel should remain model-shaped. It should not expose the full
App Server API directly through `BaseChatModel`. App Server-only capabilities
should surface through metadata, content blocks, callback events, and optional
advanced helpers.

## LangChain/LangGraph Contract

The migration must preserve these behaviors:

- `invoke()` returns an `AIMessage`.
- `stream()` yields coherent `AIMessageChunk` values.
- `streamEvents()` shows Codex progress through custom callback events.
- `withStructuredOutput()` maps to Codex `outputSchema`.
- Codex runtime activity maps to server-side tool content blocks and metadata.
- Explicit `threadId` resume remains available for LangGraph checkpointing.

Codex runtime tools are not the same as LangChain client-side tools:

- Codex runtime tools: shell commands, file changes, MCP calls, web search,
  apps, skills, and other Codex harness activity inside a Codex turn.
- LangChain client-side tools: `AIMessage.tool_calls` executed by a LangGraph
  `ToolNode` or a LangChain agent loop.
- App Server dynamic tools: client-executed tools inside the Codex turn; useful
  later, but experimental and not equivalent to the standard LangGraph tool
  loop.

Do not advertise native LangChain tool calling until the adapter can return
standard `AIMessage.tool_calls` reliably.

## Phase 1: Runtime Boundary

Goals:

- Add runtime-neutral types for inputs, thread options, turn options, usage,
  items, and events.
- Adapt the existing SDK implementation to the runtime boundary without changing
  behavior.
- Add a `runtime` constructor option, initially defaulting to `sdk`.
- Keep the current `codexClient` test injection path for compatibility while
  introducing runtime injection for App Server tests.

Acceptance criteria:

- Existing unit tests still pass.
- Public behavior is unchanged by default.
- `runtime: "app-server"` is wired but documented as experimental.

## Phase 2: App Server JSON-RPC Client

Goals:

- Spawn `codex app-server` with stdio transport.
- Send `initialize` and `initialized` once per process.
- Correlate JSON-RPC request ids with responses.
- Route notifications by `threadId` and active `turnId`.
- Support graceful `close()` so Node processes do not hang.
- Normalize JSON-RPC errors through existing Codex error handling.

Use stdio first. WebSocket is documented as experimental and unsupported, so it
is not part of the first migration slice.

Consider generating protocol bindings with:

```bash
codex app-server generate-ts --out src/generated/app-server
```

Generated types should be treated as version-specific to the installed Codex
binary.

Acceptance criteria:

- The client can initialize, start a thread, start a turn, collect streamed
  notifications, and shut down.
- A fake transport can drive unit tests without spawning a real Codex process.

## Phase 3: ChatModel App Server MVP

Map current ChatModel behavior to App Server:

| ChatModel feature | App Server primitive |
| --- | --- |
| Fresh invocation | `thread/start` then `turn/start` |
| Explicit resume | `thread/resume` then `turn/start` |
| Structured output | `turn/start.outputSchema` |
| Cancellation | `turn/interrupt` |
| Local image input | `localImage` input item |
| Model | `thread/start.model` and `turn/start.model` |
| Working directory | `cwd` |
| Sandbox | `sandbox` or `sandboxPolicy` |
| Reasoning effort | `effort` |
| Usage metadata | `turn/completed` |

Event mapping:

| App Server event | LangChain output |
| --- | --- |
| `item/agentMessage/delta` | Text chunk |
| `agentMessage` item | Final text state |
| `reasoning` item | Reasoning content block |
| `commandExecution` item | `server_tool_call` / `server_tool_call_result` |
| `fileChange` item | `non_standard` or server tool result block |
| `mcpToolCall` item | `server_tool_call` / `server_tool_call_result` |
| `webSearch` item | `server_tool_call` |
| `turn/completed` | Final usage and metadata chunk |
| `turn/failed` | Normalized error |

Acceptance criteria:

- `invoke()`, `stream()`, `streamEvents()`, and `withStructuredOutput()` work
  through App Server.
- Content-block and callback event behavior remains aligned with the SDK path.

## Phase 4: Approvals

App Server can pause a turn and send server-initiated approval requests. A
ChatModel backend must not deadlock if approvals appear.

Add an explicit approval API:

```ts
approvalHandler?: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
defaultApprovalDecision?: "decline" | "cancel" | "throw";
```

Initial default should be conservative: throw or decline when approval is
requested and no handler exists.

Acceptance criteria:

- Command and file-change approval requests are surfaced.
- Missing handlers fail clearly.
- Approval responses unblock the App Server turn.

## Phase 5: LangGraph Resume Semantics

LangGraph often passes the full message state on every model call. Codex threads
also persist history. Combining both can duplicate context.

Rules:

- Default ChatModel mode should stay message-history based and safe.
- Persistent Codex thread mode stays explicit through `threadId`.
- A model instance pinned to one default `threadId` should use
  `maxConcurrency: 1`.
- Documentation must explain that resuming a Codex thread should usually send
  only the new user turn, not the entire prior LangGraph state, unless the user
  intentionally wants that duplication.

Acceptance criteria:

- The LangGraph thread-resume example is updated for App Server.
- Concurrency and duplicated-history risks are documented.

## Phase 6: Tool Calling

Keep the existing prompt-mediated `bindTools()` compatibility during the App
Server migration. Revisit App Server dynamic tools only after the core runtime is
stable.

Acceptance criteria:

- `bindTools()` behavior remains documented as experimental emulation.
- App Server dynamic tools are not presented as native LangChain tool calling
  unless they can produce standard LangChain `AIMessage.tool_calls`.

## Phase 7: Default Flip And Deprecation

Ship in stages:

1. Add `runtime: "app-server"` as opt-in.
2. Run parity tests for both runtimes.
3. Add real App Server integration tests behind an opt-in environment variable.
4. Mark App Server runtime beta in the README.
5. Flip the default to App Server after parity and process-cleanup reliability
   are proven.
6. Keep SDK runtime for at least one or two minor releases.
7. Deprecate SDK runtime only if App Server is stable in CI and real usage.

Because this affects runtime behavior and public package behavior, code changes
for this migration require a changeset. Documentation-only planning changes do
not require one.

## Definition Of Done

App Server can become the default when:

- `invoke()`, `stream()`, `streamEvents()`, and `withStructuredOutput()` pass
  parity tests.
- No child App Server process remains after normal use or test completion.
- Abort signals interrupt active turns.
- Approval requests never hang silently.
- `threadId` resume works and is documented for LangGraph.
- Codex command/file/MCP/web activity is preserved in content blocks and custom
  callback events.
- SDK/App Server behavioral differences are documented.

## Current Progress

Initial implementation slice completed:

- Added `runtime: "app-server"` as an opt-in backend.
- Added a stdio JSON-RPC App Server client with request/response correlation.
- Normalized App Server streamed events into the adapter's existing Codex
  event/item shape.
- Mapped App Server token usage updates into existing usage metadata.
- Added conservative approval handling so App Server requests do not hang
  silently.
- Added `ChatCodexSDK.close()` for App Server process cleanup.
- Kept `runtime: "sdk"` as the default.

Remaining before default flip:

- Continue hardening the real App Server integration tests behind
  `CODEX_APP_SERVER_INTEGRATION=1`.
- Add live coverage for cancellation and approval flows where reliable prompts
  are practical.
- Decide whether and when to deprecate the SDK runtime.

Phase 3 follow-up slice added:

- Added an opt-in live App Server integration suite for `invoke()`, `stream()`,
  `streamEvents()`, explicit `threadId` resume, and `withStructuredOutput()`.
- Updated the App Server handshake to declare `experimentalApi` capability before
  requesting extended persisted history.

Phase 4 follow-up slice added:

- Routed command and file-change approval server requests through
  `appServerApprovalHandler`.
- Changed missing App Server approval handlers to fail the active turn clearly by
  default instead of silently choosing an approval response.
- Added `appServerDefaultApprovalDecision` for hosts that want unattended
  requests to resolve as `"decline"` or `"cancel"`.
- Added unit coverage for command approvals, file-change approvals, default
  approval responses, and approval handler failures.
