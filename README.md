# langchain-codex

[![npm version](https://img.shields.io/npm/v/langchain-codex.svg)](https://www.npmjs.com/package/langchain-codex)
[![npm downloads](https://img.shields.io/npm/dm/langchain-codex.svg)](https://www.npmjs.com/package/langchain-codex)
[![CI](https://github.com/euan-cowie/langchain-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/euan-cowie/langchain-codex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/euan-cowie/langchain-codex/blob/main/LICENSE)

LangChain.js chat model adapter for OpenAI Codex SDK.

`langchain-codex` lets LangChain and LangGraph code use local Codex through the official
`@openai/codex-sdk`.

```ts
import { ChatCodexSDK } from "langchain-codex";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
});

const response = await model.invoke("Review this repo and summarize the risks.");
console.log(response.content);
```

## Status

This package is published on npm as `langchain-codex`. The API is still pre-1.0 and may change between minor releases.

## What This Is

This package adapts the local Codex runtime to LangChain's `BaseChatModel` interface.

```text
LangChain / LangGraph JS
  -> ChatCodexSDK
    -> @openai/codex-sdk
      -> local codex CLI runtime
        -> existing Codex auth session or API-key auth
```

It is intended for repository review, coding-agent workflows, LangGraph nodes, and automation
where Codex's local runtime is the model provider.

## What This Is Not

- It is not a wrapper around the OpenAI API.
- It does not handle OAuth tokens directly.
- It does not call private Codex backend APIs.
- It does not support browser use.
- Its `bindTools()` support is experimental and prompt-mediated, not SDK-native provider tool calling.

Codex has its own local tools, shell access, patching, sandboxing, approvals, and persisted
threads. Those are different from provider-side LangChain tool calling.

## Installation

```bash
npm install langchain-codex @langchain/core zod
```

For local repository development:

```bash
npm install
npm run build
```

## Requirements

- Node.js 20 or later.
- `@openai/codex-sdk`, installed as a runtime dependency of this package.
- Codex authentication configured through the Codex CLI, IDE/app, or API-key auth.

## Module Format

`langchain-codex` is ESM-only and supports Node.js 20 or later. Use `import` syntax from ESM
projects:

```ts
import { ChatCodexSDK } from "langchain-codex";
```

CommonJS output is not published in v0.1.

## Authentication

This package does not handle OAuth tokens directly. It relies on the local Codex runtime and
whatever authentication that runtime supports.

For local development, authenticate Codex before using this adapter:

```bash
codex login
```

For hosted or CI usage, configure Codex API-key auth according to the Codex documentation. Do not
commit Codex auth files or API keys.

## Basic Usage

```ts
import { ChatCodexSDK } from "langchain-codex";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
});

const response = await model.invoke("Summarize this repository.");

console.log(response.content);
console.log(response.response_metadata.codex?.threadId);
```

## Streaming

Codex streaming is event-based. When Codex emits updated `agent_message` items, this adapter diffs
the message text and yields LangChain `AIMessageChunk` values.

```ts
const stream = await model.stream("Review this repo and list the main risks.");

for await (const chunk of stream) {
  process.stdout.write(
    typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content),
  );
}
```

If Codex emits only a completed message, the stream may contain one large text chunk rather than
token-sized chunks.

## Structured Output

Codex supports native per-turn `outputSchema`. You can pass JSON Schema directly:

```ts
const response = await model.invoke("Summarize repository status.", {
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      status: { type: "string", enum: ["ok", "action_required"] },
    },
    required: ["summary", "status"],
    additionalProperties: false,
  },
});
```

For Zod schemas, use `withStructuredOutput()`:

```ts
import { z } from "zod";

const structured = model.withStructuredOutput(
  z.object({
    summary: z.string(),
    riskLevel: z.enum(["low", "medium", "high"]),
  }),
);

const result = await structured.invoke("Review this repo.");
console.log(result.riskLevel);
```

Use `includeRaw` when you need the original LangChain message:

```ts
const structured = model.withStructuredOutput(schema, { includeRaw: true });
const result = await structured.invoke("Review this repo.");

console.log(result.raw.response_metadata);
console.log(result.parsed);
```

## Experimental Tool Calling

`bindTools()` is available as an experimental LangChain compatibility layer. The Codex SDK does not
currently expose a native JavaScript tool registration API, so this adapter uses Codex
`outputSchema` plus tool instructions to return LangChain `AIMessage.tool_calls`.

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const multiply = tool(async ({ a, b }) => a * b, {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

const modelWithTools = model.bindTools([multiply]);
const response = await modelWithTools.invoke("What is 6 * 7?");

console.log(response.tool_calls);
```

LangChain or LangGraph can execute those tool calls and feed back `ToolMessage` results on the next
turn:

```ts
import { HumanMessage, ToolMessage } from "@langchain/core/messages";

const toolCall = response.tool_calls?.[0];
const final = await modelWithTools.invoke([
  new HumanMessage("What is 6 * 7?"),
  response,
  new ToolMessage({
    content: "42",
    tool_call_id: toolCall?.id ?? "missing-tool-call-id",
    name: "multiply",
  }),
]);
```

Supported `tool_choice` values are `"auto"`, `"any"`, `"none"`, a tool name string, and common
OpenAI-style function tool-choice objects. Streaming tool-call chunks are not native yet; streaming
with bound tools yields the completed tool-call message as a final chunk.

### LangGraph ToolNode

The experimental tool-call shape is compatible with LangGraph's `ToolNode` and `toolsCondition`
patterns:

```ts
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";

const modelWithTools = model.bindTools([multiply]);
const toolNode = new ToolNode([multiply]);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state) => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  })
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent")
  .compile();
```

This uses LangGraph to execute client-side LangChain tools. It does not turn those tools into native
Codex runtime tools.

## Model Profile

`ChatCodexSDK` exposes a conservative LangChain model profile so dynamic LangChain and LangGraph
code can inspect supported capabilities:

```ts
console.log(model.profile);
// {
//   structuredOutput: true,
//   imageInputs: true,
//   imageUrlInputs: false,
//   reasoningOutput: true,
//   toolCalling: true,
//   toolChoice: true,
//   ...
// }
```

## Thread Resume

By default, each call starts a new Codex thread. This keeps `.batch()` behavior predictable and close
to other LangChain chat models.

To continue a Codex thread, pass the returned thread ID into a later call:

```ts
const first = await model.invoke("Inspect this repository.");
const threadId = first.response_metadata.codex?.threadId;

const second = await model.invoke(
  "Continue with a concise risk summary.",
  threadId === undefined ? undefined : { threadId },
);
```

You can also construct a stateful model with a default `threadId`, but avoid concurrent calls on the
same stateful instance.

## Working Directory and Sandbox

Codex runs against a local working directory. This adapter defaults to safer settings:

```ts
const model = new ChatCodexSDK({
  workingDirectory: "/path/to/repo",
  sandboxMode: "read-only",
  networkAccessEnabled: false,
});
```

Use `workspace-write` only when you want Codex to edit files:

```ts
const model = new ChatCodexSDK({
  workingDirectory: "/path/to/repo",
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
});
```

Codex requires a git repository by default. For temporary or generated directories, pass
`skipGitRepoCheck: true` intentionally.

## Constructor Options

```ts
type ChatCodexSDKFields = {
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;

  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  additionalDirectories?: string[];

  threadId?: string;
  env?: Record<string, string>;
  baseUrl?: string;
  apiKey?: string;
  codexPathOverride?: string;
  codexConfig?: Record<string, unknown>;

  timeoutMs?: number;
  maxConcurrency?: number;
};
```

## Unsupported Features

Stop sequences are also rejected in v0.1 because Codex runs through the local agent runtime rather
than a plain text-completion endpoint.

Raw provider `tools` call options are rejected. Pass tools through `model.bindTools(tools)` so the
experimental adapter can build the Codex prompt and output schema.

## Troubleshooting

Missing or expired auth:

```text
Codex authentication is required. This package does not handle OAuth tokens directly.
```

Run `codex login` locally, or configure Codex API-key auth in hosted environments.

Missing Codex runtime:

```text
Could not start the local Codex runtime.
```

Ensure Codex is installed and available on `PATH`, or pass `codexPathOverride`.

Non-git working directory:

```text
Codex requires a git working directory by default.
```

Use a git repository, or pass `skipGitRepoCheck: true` when intentional.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Integration tests are opt-in because they require local Codex auth:

```bash
RUN_CODEX_INTEGRATION_TESTS=1 npm run test:integration
```

## Version Compatibility

The first release targets:

- `@langchain/core` 1.x
- `@openai/codex-sdk` 0.125.x
- Node.js 20 or later

The Codex SDK is moving quickly. This package pins a conservative dependency range and wraps the
SDK behind a small adapter surface.

## License

MIT
