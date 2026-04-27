import type { ToolCall } from "@langchain/core/messages";
import type { BindToolsInput, ToolChoice } from "@langchain/core/language_models/chat_models";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { CodexStructuredOutputError, CodexUnsupportedFeatureError } from "./errors.js";
import type { CodexInput } from "./types.js";

export type CodexBoundTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type NormalizedToolChoice =
  | { kind: "auto" }
  | { kind: "any" }
  | { kind: "none" }
  | { kind: "tool"; name: string };

export type CodexToolCallingConfig = {
  tools: CodexBoundTool[];
  toolChoice: NormalizedToolChoice;
};

export type CodexToolCallingResult =
  | { type: "final"; content: string }
  | { type: "tool_calls"; content: string; toolCalls: ToolCall[] };

export function createCodexToolCallingConfig(
  tools: BindToolsInput[],
  kwargs?: { tool_choice?: ToolChoice },
): CodexToolCallingConfig {
  const convertedTools = tools.map(convertBindToolsInput);
  const toolChoice = normalizeToolChoice(kwargs?.tool_choice);

  validateToolChoice(toolChoice, convertedTools);

  return {
    tools: convertedTools,
    toolChoice,
  };
}

export function prependToolCallingInstructions(
  input: CodexInput,
  config: CodexToolCallingConfig,
): CodexInput {
  const instructions = createToolCallingInstructions(config);

  if (typeof input === "string") {
    return `${instructions}\n\n${input}`.trimEnd();
  }

  return [{ type: "text", text: instructions }, ...input];
}

export function createToolCallingOutputSchema(
  config: CodexToolCallingConfig,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "content", "tool_calls"],
    properties: {
      type: {
        type: "string",
        enum: ["final", "tool_calls"],
      },
      content: {
        type: "string",
        description: "Final assistant answer text. Use an empty string when type is tool_calls.",
      },
      tool_calls: {
        type: "array",
        description:
          "Client-side LangChain tool calls to execute. Use this only when type is tool_calls.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "args"],
          properties: {
            id: {
              type: "string",
              description: "Stable tool call id generated for this client-side tool call.",
            },
            name: { type: "string", enum: config.tools.map((tool) => tool.name) },
            args: {
              type: "string",
              description:
                "JSON object string containing arguments for the selected tool. Match the selected tool's parameter schema from the prompt instructions.",
            },
          },
        },
      },
    },
  };
}

export function parseCodexToolCallingResponse(
  text: string,
  config: CodexToolCallingConfig,
): CodexToolCallingResult {
  const parsed = parseToolCallingJson(text);

  if (!isRecord(parsed)) {
    throw new CodexStructuredOutputError("Codex tool-calling response must be a JSON object.");
  }

  if (parsed.type === "final") {
    if (config.toolChoice.kind === "any" || config.toolChoice.kind === "tool") {
      throw new CodexStructuredOutputError(
        `Codex returned a final answer, but tool_choice required ${formatToolChoice(config.toolChoice)}.`,
      );
    }

    if (typeof parsed.content !== "string") {
      throw new CodexStructuredOutputError(
        'Codex tool-calling final response must include string "content".',
      );
    }

    return { type: "final", content: parsed.content };
  }

  if (parsed.type !== "tool_calls") {
    throw new CodexStructuredOutputError(
      'Codex tool-calling response "type" must be either "final" or "tool_calls".',
    );
  }

  if (config.toolChoice.kind === "none") {
    throw new CodexStructuredOutputError(
      "Codex returned tool calls, but tool_choice required no tool calls.",
    );
  }

  if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
    throw new CodexStructuredOutputError(
      'Codex tool-calling response must include a non-empty "tool_calls" array.',
    );
  }

  const toolCalls = parsed.tool_calls.map((toolCall, index) =>
    normalizeReturnedToolCall(toolCall, index, config),
  );
  const content = typeof parsed.content === "string" ? parsed.content : "";

  return {
    type: "tool_calls",
    content,
    toolCalls,
  };
}

function convertBindToolsInput(tool: BindToolsInput): CodexBoundTool {
  const converted = convertToOpenAITool(tool as Parameters<typeof convertToOpenAITool>[0]);

  if (!isRecord(converted) || converted.type !== "function" || !isRecord(converted.function)) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK.bindTools() currently supports LangChain tools and OpenAI-style function tools only.",
    );
  }

  const fn = converted.function;

  if (typeof fn.name !== "string" || fn.name.length === 0) {
    throw new CodexUnsupportedFeatureError("Bound tools must have a non-empty function name.");
  }

  return {
    name: fn.name,
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
  };
}

function createToolCallingInstructions(config: CodexToolCallingConfig): string {
  const tools = config.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
  }));

  return [
    "Experimental LangChain tool-calling mode is active.",
    "The tools below are client-side LangChain tools. Do not execute them with shell commands, MCP, web search, or Codex local tools.",
    'When a tool is needed, return JSON with type "tool_calls" and a tool_calls array. LangChain will execute those tool calls after this turn.',
    'Always include both content and tool_calls. For final answers, set tool_calls to []. For tool-call responses, set content to "" unless useful assistant text is needed.',
    "Every tool call must include an id, name, and args.",
    "For each tool call, set args to a JSON object encoded as a string.",
    'When no tool is needed, return JSON with type "final" and a content string.',
    "If prior Tool messages are present, use their results to produce a final answer unless another tool call is still required.",
    "Do not repeat a tool call when a prior Tool result already answers the current request.",
    `Tool choice: ${formatToolChoice(config.toolChoice)}.`,
    "Available tools:",
    JSON.stringify(tools, null, 2),
  ].join("\n");
}

function normalizeToolChoice(toolChoice: ToolChoice | undefined): NormalizedToolChoice {
  if (toolChoice === undefined || toolChoice === "auto") {
    return { kind: "auto" };
  }

  if (toolChoice === "any") {
    return { kind: "any" };
  }

  if (toolChoice === "none") {
    return { kind: "none" };
  }

  if (typeof toolChoice === "string") {
    return { kind: "tool", name: toolChoice };
  }

  if (isRecord(toolChoice)) {
    if (typeof toolChoice.name === "string") {
      return { kind: "tool", name: toolChoice.name };
    }

    if (isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
      return { kind: "tool", name: toolChoice.function.name };
    }
  }

  throw new CodexUnsupportedFeatureError(
    "ChatCodexSDK.bindTools() supports tool_choice values auto, any, none, a tool name, or OpenAI-style function tool choices.",
  );
}

function validateToolChoice(choice: NormalizedToolChoice, tools: CodexBoundTool[]): void {
  if (choice.kind !== "tool") {
    return;
  }

  if (!tools.some((tool) => tool.name === choice.name)) {
    throw new CodexUnsupportedFeatureError(`tool_choice requires unknown tool "${choice.name}".`);
  }
}

function parseToolCallingJson(text: string): unknown {
  try {
    return JSON.parse(stripMarkdownJsonFence(text.trim()));
  } catch (error) {
    throw new CodexStructuredOutputError(
      `Codex returned malformed tool-calling JSON: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function normalizeReturnedToolCall(
  value: unknown,
  index: number,
  config: CodexToolCallingConfig,
): ToolCall {
  if (!isRecord(value)) {
    throw new CodexStructuredOutputError("Each Codex tool call must be a JSON object.");
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new CodexStructuredOutputError('Each Codex tool call must include string "name".');
  }

  if (config.toolChoice.kind === "tool" && value.name !== config.toolChoice.name) {
    throw new CodexStructuredOutputError(
      `Codex returned tool "${value.name}", but tool_choice required "${config.toolChoice.name}".`,
    );
  }

  if (!config.tools.some((tool) => tool.name === value.name)) {
    throw new CodexStructuredOutputError(`Codex returned unknown tool "${value.name}".`);
  }

  const args = parseToolCallArgs(value.args, value.name);

  if (!isRecord(args)) {
    throw new CodexStructuredOutputError(
      `Codex tool call "${value.name}" must include object "args".`,
    );
  }

  return {
    type: "tool_call",
    id:
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : defaultToolCallId(value.name, index),
    name: value.name,
    args,
  };
}

function parseToolCallArgs(value: unknown, toolName: string): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CodexStructuredOutputError(
      `Codex tool call "${toolName}" returned malformed JSON args: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function defaultToolCallId(name: string, index: number): string {
  const suffix = name.replace(/[^a-zA-Z0-9_-]+/g, "_") || "tool";
  return `call_${index + 1}_${suffix}`;
}

function formatToolChoice(choice: NormalizedToolChoice): string {
  switch (choice.kind) {
    case "auto":
      return "auto, call tools only when needed";
    case "any":
      return "any, call at least one available tool";
    case "none":
      return "none, return a final answer without tool calls";
    case "tool":
      return `you must call the ${choice.name} tool`;
  }
}

function stripMarkdownJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && "message" in error) {
    return String(error.message);
  }

  return String(error);
}
