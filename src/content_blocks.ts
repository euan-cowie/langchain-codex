import type { ThreadItem } from "@openai/codex-sdk";
import type { ContentBlock } from "@langchain/core/messages";

export type CodexContentBlock = ContentBlock.Standard;

export function threadItemsToContentBlocks(
  items: ThreadItem[],
  finalResponse: string,
): CodexContentBlock[] {
  const blocks = items.flatMap((item) =>
    item.type === "agent_message" ? [] : contentBlocksFromThreadItem(item, "final"),
  );

  if (finalResponse.length > 0) {
    blocks.push({ type: "text", text: finalResponse });
  }

  return blocks;
}

export function contentBlocksFromThreadItem(
  item: ThreadItem,
  phase: "started" | "updated" | "completed" | "final",
): CodexContentBlock[] {
  switch (item.type) {
    case "agent_message":
      return item.text.length > 0 ? [{ id: item.id, type: "text", text: item.text }] : [];
    case "reasoning":
      return item.text.length > 0 ? [{ id: item.id, type: "reasoning", reasoning: item.text }] : [];
    case "command_execution":
      return commandExecutionBlocks(item, phase);
    case "mcp_tool_call":
      return mcpToolCallBlocks(item, phase);
    case "web_search":
      return phase === "updated" ? [] : [webSearchCallBlock(item)];
    case "file_change":
    case "todo_list":
    case "error":
      return [{ id: item.id, type: "non_standard", value: item }];
    default:
      return [];
  }
}

export function shouldUseContentBlocks(
  blocks: CodexContentBlock[],
  finalResponse: string,
  forceV1: boolean,
): boolean {
  if (forceV1) {
    return true;
  }

  const textBlocks = blocks.filter((block): block is ContentBlock.Text => block.type === "text");

  return (
    blocks.some((block) => block.type !== "text") ||
    textBlocks.length !== 1 ||
    textBlocks[0]?.text !== finalResponse
  );
}

export function reasoningDeltaBlock(
  item: ThreadItem,
  previousTextById: Map<string, string>,
): CodexContentBlock[] {
  if (item.type !== "reasoning") {
    return [];
  }

  const previousText = previousTextById.get(item.id) ?? "";
  previousTextById.set(item.id, item.text);
  const delta = item.text.startsWith(previousText)
    ? item.text.slice(previousText.length)
    : item.text;

  return delta.length > 0 ? [{ id: item.id, type: "reasoning", reasoning: delta }] : [];
}

function commandExecutionBlocks(
  item: Extract<ThreadItem, { type: "command_execution" }>,
  phase: "started" | "updated" | "completed" | "final",
): CodexContentBlock[] {
  if (phase === "started" || (phase === "final" && item.status === "in_progress")) {
    return [commandExecutionCallBlock(item)];
  }

  if (phase === "completed") {
    return [commandExecutionResultBlock(item)];
  }

  if (phase === "final") {
    return [commandExecutionCallBlock(item), commandExecutionResultBlock(item)];
  }

  return [];
}

function commandExecutionCallBlock(
  item: Extract<ThreadItem, { type: "command_execution" }>,
): CodexContentBlock {
  return {
    id: item.id,
    type: "server_tool_call",
    name: "codex_shell",
    args: { command: item.command },
  };
}

function commandExecutionResultBlock(
  item: Extract<ThreadItem, { type: "command_execution" }>,
): CodexContentBlock {
  const output: Record<string, unknown> = {
    command: item.command,
    output: item.aggregated_output,
  };

  if (item.exit_code !== undefined) {
    output.exitCode = item.exit_code;
  }

  return {
    type: "server_tool_call_result",
    name: "codex_shell",
    toolCallId: item.id,
    status: item.status === "failed" ? "error" : "success",
    output,
  };
}

function mcpToolCallBlocks(
  item: Extract<ThreadItem, { type: "mcp_tool_call" }>,
  phase: "started" | "updated" | "completed" | "final",
): CodexContentBlock[] {
  if (phase === "started" || (phase === "final" && item.status === "in_progress")) {
    return [mcpToolCallBlock(item)];
  }

  if (phase === "completed") {
    return [mcpToolCallResultBlock(item)];
  }

  if (phase === "final") {
    return [mcpToolCallBlock(item), mcpToolCallResultBlock(item)];
  }

  return [];
}

function mcpToolCallBlock(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): CodexContentBlock {
  return {
    id: item.id,
    type: "server_tool_call",
    name: `${item.server}.${item.tool}`,
    args: item.arguments,
  };
}

function mcpToolCallResultBlock(
  item: Extract<ThreadItem, { type: "mcp_tool_call" }>,
): CodexContentBlock {
  const output: Record<string, unknown> = {};

  if (item.result !== undefined) {
    output.content = item.result.content;
    output.structuredContent = item.result.structured_content;
  }

  if (item.error !== undefined) {
    output.error = item.error.message;
  }

  return {
    type: "server_tool_call_result",
    name: `${item.server}.${item.tool}`,
    toolCallId: item.id,
    status: item.status === "failed" ? "error" : "success",
    output,
  };
}

function webSearchCallBlock(item: Extract<ThreadItem, { type: "web_search" }>): CodexContentBlock {
  return {
    id: item.id,
    type: "server_tool_call",
    name: "web_search",
    args: { query: item.query },
  };
}
