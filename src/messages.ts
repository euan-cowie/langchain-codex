import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import { fileURLToPath } from "node:url";
import { CodexUnsupportedFeatureError } from "./errors.js";
import type { CodexInput } from "./types.js";

type CodexInputEntry = Exclude<CodexInput, string>[number];

type MutableCodexInputBuilder = {
  text: string;
  entries: CodexInputEntry[];
  hasImages: boolean;
};

export function convertMessagesToCodexInput(messages: BaseMessage[]): CodexInput {
  const builder: MutableCodexInputBuilder = {
    text: "",
    entries: [],
    hasImages: false,
  };

  for (const message of messages) {
    appendMessage(builder, message);
  }

  if (!builder.hasImages) {
    return builder.text.trimEnd();
  }

  flushText(builder);
  return builder.entries;
}

function appendMessage(builder: MutableCodexInputBuilder, message: BaseMessage): void {
  appendText(builder, `${roleLabel(message)}:\n`);
  appendContent(builder, message.content, message.type === "ai");
  appendText(builder, "\n\n");
}

function appendContent(
  builder: MutableCodexInputBuilder,
  content: MessageContent,
  ignoreOutputRuntimeBlocks: boolean,
): void {
  if (typeof content === "string") {
    appendText(builder, content);
    return;
  }

  for (const block of content) {
    appendContentBlock(builder, block, ignoreOutputRuntimeBlocks);
  }
}

function appendContentBlock(
  builder: MutableCodexInputBuilder,
  block: unknown,
  ignoreOutputRuntimeBlocks: boolean,
): void {
  if (typeof block === "string") {
    appendText(builder, block);
    return;
  }

  if (!isRecord(block)) {
    throw new CodexUnsupportedFeatureError(
      `Unsupported LangChain message content block: ${String(block)}`,
    );
  }

  if (block.type === "text" && typeof block.text === "string") {
    appendText(builder, block.text);
    return;
  }

  if (block.type === "text-plain" && typeof block.text === "string") {
    appendText(builder, block.text);
    return;
  }

  if (ignoreOutputRuntimeBlocks && isOutputRuntimeBlock(block)) {
    return;
  }

  const imagePath = getLocalImagePath(block);
  if (imagePath !== undefined) {
    appendImage(builder, imagePath);
    return;
  }

  if (isImageLikeBlock(block)) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK only supports local image paths in v0.1. Remote URLs, base64 data, file IDs, audio, video, and generic files are not supported.",
    );
  }

  throw new CodexUnsupportedFeatureError(
    `Unsupported LangChain message content block type: ${stringifyBlockType(block.type)}`,
  );
}

function isOutputRuntimeBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "reasoning" ||
    block.type === "server_tool_call" ||
    block.type === "server_tool_call_chunk" ||
    block.type === "server_tool_call_result" ||
    block.type === "non_standard"
  );
}

function appendText(builder: MutableCodexInputBuilder, text: string): void {
  builder.text += text;
}

function appendImage(builder: MutableCodexInputBuilder, path: string): void {
  flushText(builder);
  builder.entries.push({ type: "local_image", path });
  builder.hasImages = true;
}

function flushText(builder: MutableCodexInputBuilder): void {
  const text = builder.text.trimEnd();

  if (text.length === 0) {
    builder.text = "";
    return;
  }

  builder.entries.push({ type: "text", text });
  builder.text = "";
}

function roleLabel(message: BaseMessage): string {
  switch (message.type) {
    case "system":
      return "System";
    case "human":
      return "Human";
    case "ai":
      return "Assistant";
    case "tool":
      return "Tool";
    case "function":
      return "Function";
    case "generic":
      return "role" in message && typeof message.role === "string" ? message.role : "Message";
    default:
      return capitalize(message.type);
  }
}

function getLocalImagePath(block: Record<string, unknown>): string | undefined {
  if (block.type === "local_image" && typeof block.path === "string") {
    return block.path;
  }

  if (block.type === "image" && typeof block.path === "string") {
    return block.path;
  }

  const imageUrl = getImageUrl(block);
  if (imageUrl === undefined) {
    return undefined;
  }

  if (/^file:\/\//i.test(imageUrl)) {
    return fileURLToPath(imageUrl);
  }

  if (/^https?:\/\//i.test(imageUrl) || /^data:/i.test(imageUrl)) {
    return undefined;
  }

  return imageUrl;
}

function getImageUrl(block: Record<string, unknown>): string | undefined {
  if (block.type === "image_url") {
    const imageUrl = block.image_url;
    if (typeof imageUrl === "string") {
      return imageUrl;
    }

    if (isRecord(imageUrl) && typeof imageUrl.url === "string") {
      return imageUrl.url;
    }
  }

  if (block.type === "image" && typeof block.url === "string") {
    return block.url;
  }

  if (block.source_type === "url" && typeof block.url === "string") {
    return block.url;
  }

  return undefined;
}

function isImageLikeBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "image" ||
    block.type === "image_url" ||
    block.type === "audio" ||
    block.type === "video" ||
    block.type === "file" ||
    typeof block.data === "string" ||
    block.data instanceof Uint8Array ||
    typeof block.fileId === "string" ||
    typeof block.id === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase()}${value.slice(1)}` : "Message";
}

function stringifyBlockType(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "unknown";
  }

  return JSON.stringify(value);
}
