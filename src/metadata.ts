import type { ThreadItem, Usage } from "@openai/codex-sdk";
import type { UsageMetadata } from "@langchain/core/messages";
import type { ChatCodexSDKResponseMetadata } from "./types.js";

export function getCodexThreadId(message: {
  response_metadata?: unknown;
}): string | undefined {
  const responseMetadata = message.response_metadata;
  if (!isRecord(responseMetadata) || !isRecord(responseMetadata.codex)) {
    return undefined;
  }

  return typeof responseMetadata.codex.threadId === "string"
    ? responseMetadata.codex.threadId
    : undefined;
}

export function toUsageMetadata(usage: Usage | null | undefined): UsageMetadata | undefined {
  if (usage == null) {
    return undefined;
  }

  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

export function toTokenUsage(usage: Usage | null | undefined): Record<string, number> | undefined {
  if (usage == null) {
    return undefined;
  }

  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

export function toCodexResponseMetadata({
  threadId,
  model,
  usage,
  items,
}: {
  threadId?: string | null | undefined;
  model?: string | undefined;
  usage?: Usage | null | undefined;
  items?: ThreadItem[] | undefined;
}): ChatCodexSDKResponseMetadata {
  const codex: ChatCodexSDKResponseMetadata["codex"] = {};

  if (threadId !== undefined) {
    codex.threadId = threadId;
  }

  if (model !== undefined) {
    codex.model = model;
  }

  if (usage != null) {
    codex.usage = usage;
  }

  if (items !== undefined) {
    codex.items = items;
  }

  return { codex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
