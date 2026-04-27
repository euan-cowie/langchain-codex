# LangChain Codex Integration Findings

Date: 2026-04-26

Historical note: this document records the initial repository review. Several recommendations here
have since been implemented, including content blocks, custom stream events, model profile,
structured-output semantics, experimental `bindTools()` compatibility, and LangGraph thread-resume
examples. See `README.md` for the current package state.

## Executive Summary

`langchain-codex` is already implemented as a LangChain chat model adapter: `ChatCodexSDK`
subclasses `BaseChatModel`, supports `invoke()`, `stream()`, `withStructuredOutput()`, usage
metadata, thread resume, and package publication.

The next best step is not to emulate `ChatOpenAI.bindTools()` immediately. The stronger next step is
to surface Codex's agent runtime activity through LangChain's standard message and event surfaces:
content blocks, server-side tool blocks, custom callback events, and a model `profile`.

That would make the package behave more like a first-class LangChain integration while preserving
Codex's different execution model: Codex executes local shell, patch, MCP, web, and file-change work
inside its own turn, while LangChain client-side tool calling expects the model to return
`AIMessage.tool_calls` for the host app or agent loop to execute.

## Repo State At Review Time

- Local checkout was clean at review time.
- GitHub repository: `euan-cowie/langchain-codex`
- Repository visibility: public.
- Default branch: `main`.
- No open pull requests found.
- No open issues found.
- Latest npm version observed: `langchain-codex@0.2.0`.
- Latest GitHub release observed: `v0.2.0`, published on 2026-04-26.
- Latest GitHub Actions runs observed on `main` were successful.
- Local branch caveat: this checkout was on `changeset-release/main`, whose upstream branch was
  deleted after the version PR merged. `origin/main` was ahead and should be the base for the next
  implementation branch.

## Code Findings

### Already a LangChain Chat Model

`ChatCodexSDK` extends `BaseChatModel<ChatCodexSDKCallOptions, AIMessageChunk>` and implements the
expected core methods:

- `_generate()` for non-streaming invocation.
- `_streamResponseChunks()` for streaming.
- `withStructuredOutput()` for schema-constrained output.
- `getLsParams()`, `invocationParams()`, `_identifyingParams()`, and `_combineLLMOutput()` for
  tracing and usage metadata.

Relevant files:

- `src/chat_codex_sdk.ts`
- `src/structured_output.ts`
- `src/metadata.ts`
- `src/types.ts`

This means the question is not "how do we make this a chat model" at the base class level. It is
"how do we make this a more complete LangChain integration."

### Structured Output Is the Strongest Parity Area

The adapter maps LangChain `withStructuredOutput()` to Codex `outputSchema`, converts Zod v4 schemas
to JSON Schema, validates Zod outputs, supports `includeRaw`, and records LangSmith structured-output
metadata.

This aligns well with LangChain's structured-output pattern and OpenAI Codex SDK support for
per-turn `outputSchema`.

Relevant files:

- `src/structured_output.ts`
- `test/unit/structured_output.test.ts`
- `test/unit/chat_codex_sdk.test.ts`

### Tool Calling Was Initially Deferred

At review time, `bindTools()` threw `CodexUnsupportedFeatureError`. The package now implements
experimental prompt-mediated `bindTools()` compatibility for LangChain client-side tools, while the
README clearly distinguishes that emulation from native Codex SDK provider tool registration.

LangChain client-side tool calling means:

- The model returns `AIMessage.tool_calls`.
- The caller or LangChain agent executes the requested tools.
- Tool results are passed back as `ToolMessage` values.

Codex behaves differently:

- Codex owns the agent loop.
- Codex can run local shell commands, apply patches, call MCP tools, search the web, and update files
  within a single Codex turn.
- Those operations appear in Codex SDK `ThreadItem` events, not as pending LangChain
  `AIMessage.tool_calls`.

The important product constraint remains: prompt-mediated `bindTools()` should not be described as
native provider tool calling.

Relevant files:

- `src/chat_codex_sdk.ts`
- `TASKS.md`

### Initial Integration Gap: Codex Events Were Hidden

Codex SDK exposes structured items such as:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`
- `web_search`
- `todo_list`
- `error`

The adapter now exposes Codex runtime activity through content blocks, `response_metadata.codex.items`,
and custom stream events, so apps, LangGraph runs, and LangSmith traces can observe command
execution, patch application, MCP calls, web search, todo changes, and reasoning without parsing raw
SDK payloads first.

Relevant files:

- `src/chat_codex_sdk.ts`
- `src/metadata.ts`

### Model Profile

LangChain 1.1 model profiles let applications discover model capabilities dynamically. The adapter
now exposes a profile for supported Codex capabilities.

The current profile includes:

```ts
{
  structuredOutput: true,
  imageInputs: true,
  imageUrlInputs: false,
  reasoningOutput: true,
  toolCalling: true,
  toolChoice: true,
}
```

The tool flags refer to the tested experimental `bindTools()` compatibility path, not native Codex
SDK tool registration.

### Multimodal Input Is Conservative but Reasonable

The adapter supports local image paths and rejects remote URLs, base64 images, audio, video, and
generic files with explicit errors. This matches the current Codex SDK input type exposed by
`@openai/codex-sdk`, which supports text and `local_image` entries.

Future support for remote URLs or base64 should only be added if:

- Codex SDK supports those inputs directly, or
- The adapter safely materializes files locally with size limits, cleanup, and clear security rules.

Relevant files:

- `src/messages.ts`
- `test/unit/messages.test.ts`

## Original Recommended Next PR

This recommendation was implemented by later work.

Title suggestion:

`feat: surface Codex agent events as LangChain content blocks`

Recommended scope:

1. Add a mapper from Codex `ThreadItem` values to LangChain v1 content blocks.
2. Populate final `AIMessage` values with `contentBlocks` and `response_metadata.output_version =
"v1"` where appropriate.
3. Emit streamed chunks for meaningful Codex events, not just `agent_message` text deltas.
4. Use LangChain custom callback events for Codex-specific runtime events:
   - `codex.command_execution.started`
   - `codex.command_execution.updated`
   - `codex.command_execution.completed`
   - `codex.file_change.completed`
   - `codex.mcp_tool_call.started`
   - `codex.mcp_tool_call.completed`
   - `codex.web_search.completed`
   - `codex.todo_list.updated`
5. Add a `profile` getter with conservative capability flags.
6. Add unit tests using fake Codex stream events.
7. Update README examples to show `message.contentBlocks` and `streamEvents()`.
8. Keep capability signaling honest by distinguishing client-side LangChain tool calling from Codex
   server-side tool activity.

## Suggested Event Mapping

| Codex item type     | LangChain projection                             | Notes                                                                               |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `agent_message`     | `text` content block                             | Continue returning normal message text.                                             |
| `reasoning`         | `reasoning` content block                        | Use summarized reasoning text from Codex item.                                      |
| `command_execution` | `server_tool_call` and `server_tool_call_result` | Treat shell as server-side tool activity because Codex executes it inside the turn. |
| `mcp_tool_call`     | `server_tool_call` and `server_tool_call_result` | Include server/tool name, args, result, and error status.                           |
| `web_search`        | `server_tool_call` and/or `non_standard`         | Use a stable block shape even if Codex item lacks full result detail.               |
| `file_change`       | `non_standard` or `server_tool_call_result`      | Preserve paths and add/update/delete status.                                        |
| `todo_list`         | `non_standard`                                   | Useful for UI and traces, but not a model text block.                               |
| `error`             | `non_standard` plus error metadata               | Keep errors visible without pretending they are natural language.                   |

## Original Tool-Calling Ordering Rationale

`ChatOpenAI` and `ChatAnthropic` advertise tool calling because their APIs can return structured
tool-call requests for the caller to execute. LangChain's docs describe this as a client-side loop:
bind tools, receive `AIMessage.tool_calls`, execute tools, then pass `ToolMessage` results back.

Codex instead runs a server-side/local-agent loop through the Codex CLI runtime. LangChain also has a
concept for server-side tool use: the model/tool provider performs tool activity during one
conversation turn and exposes those invocations/results in message content blocks. That is a better
fit for Codex.

The original recommended ordering was:

1. Surface Codex's built-in tool/runtime events as server-side content blocks and callback events.
2. Add a model `profile` with accurate capability flags.
3. Explore prompt-mediated tool calling only if it can satisfy LangChain's actual tool-call
   contract and can be labeled clearly as emulation rather than native provider tool calling.

## Verification Performed

Commands that passed:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm --cache /tmp/langchain-codex-npm-cache run pack:dry-run
```

Notes:

- The first `npm run pack:dry-run` and `npm run smoke:package` attempts failed due to a local
  `~/.npm` cache permission issue.
- `pack:dry-run` passed when rerun with a temp npm cache.
- `smoke:package` later stalled inside a temp-project `npm install`; it was stopped. That looked like
  an environment/network stall rather than a code failure.

## Sources

LangChain docs:

- ChatOpenAI integration:
  https://docs.langchain.com/oss/javascript/integrations/chat/openai
- ChatAnthropic integration:
  https://docs.langchain.com/oss/javascript/integrations/chat/anthropic
- OpenAI tools integration:
  https://docs.langchain.com/oss/javascript/integrations/tools/openai
- LangChain models guide:
  https://docs.langchain.com/oss/javascript/langchain/models
- LangChain tool calling section:
  https://docs.langchain.com/oss/javascript/langchain/models#tool-calling
- LangChain server-side tool use section:
  https://docs.langchain.com/oss/javascript/langchain/models#server-side-tool-use
- LangChain model profiles section:
  https://docs.langchain.com/oss/javascript/langchain/models#model-profiles
- LangChain structured output section:
  https://docs.langchain.com/oss/javascript/langchain/models#structured-output

OpenAI docs:

- Codex SDK:
  https://developers.openai.com/codex/sdk
- Codex SDK npm package:
  https://www.npmjs.com/package/@openai/codex-sdk

Repository and package sources:

- GitHub repository:
  https://github.com/euan-cowie/langchain-codex
- GitHub Actions:
  https://github.com/euan-cowie/langchain-codex/actions
- GitHub release `v0.2.0`:
  https://github.com/euan-cowie/langchain-codex/releases/tag/v0.2.0
- npm package `langchain-codex`:
  https://www.npmjs.com/package/langchain-codex

Local source files reviewed:

- `src/chat_codex_sdk.ts`
- `src/messages.ts`
- `src/structured_output.ts`
- `src/metadata.ts`
- `src/types.ts`
- `test/unit/chat_codex_sdk.test.ts`
- `test/unit/messages.test.ts`
- `test/unit/structured_output.test.ts`
- `test/integration/chat_codex_sdk.integration.test.ts`
- `README.md`
- `TASKS.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/version.yml`
