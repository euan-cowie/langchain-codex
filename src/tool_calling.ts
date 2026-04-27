import type { ToolCall } from "@langchain/core/messages";
import type { BindToolsInput, ToolChoice } from "@langchain/core/language_models/chat_models";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import Ajv from "ajv";
import { CodexStructuredOutputError, CodexUnsupportedFeatureError } from "./errors.js";
import type { CodexInput } from "./types.js";

export type ToolCallValidationMode = "strict" | "basic";

export type CodexBoundTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  validateArgs: (args: Record<string, unknown>) => void;
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
  validationMode: ToolCallValidationMode = "strict",
): CodexInput {
  const instructions = createToolCallingInstructions(config, validationMode);

  if (typeof input === "string") {
    return `${instructions}\n\n${input}`.trimEnd();
  }

  return [{ type: "text", text: instructions }, ...input];
}

export function createToolCallingOutputSchema(
  config: CodexToolCallingConfig,
  validationMode: ToolCallValidationMode = "strict",
): Record<string, unknown> {
  if (validationMode === "basic") {
    return createBasicToolCallingOutputSchema(config);
  }

  const toolCallItems = createStrictToolCallItemsSchema(config);
  const requiresToolCalls = config.toolChoice.kind === "any" || config.toolChoice.kind === "tool";
  const requiresFinal = config.toolChoice.kind === "none";

  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "content", "tool_calls"],
    properties: {
      type: {
        type: "string",
        enum: requiresFinal
          ? ["final"]
          : requiresToolCalls
            ? ["tool_calls"]
            : ["final", "tool_calls"],
      },
      content: {
        type: "string",
        description: "Final assistant answer text. Use an empty string when type is tool_calls.",
      },
      tool_calls: {
        type: "array",
        description:
          "Client-side LangChain tool calls to execute. Use this only when type is tool_calls.",
        ...(requiresToolCalls ? { minItems: 1 } : {}),
        ...(requiresFinal ? { maxItems: 0 } : {}),
        items: toolCallItems,
      },
    },
  };
}

export function parseCodexToolCallingResponse(
  text: string,
  config: CodexToolCallingConfig,
  options?: { validationMode?: ToolCallValidationMode },
): CodexToolCallingResult {
  const validationMode = options?.validationMode ?? "strict";
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

    if (
      validationMode === "strict" &&
      (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length !== 0)
    ) {
      throw new CodexStructuredOutputError(
        'Codex tool-calling final response must include empty "tool_calls".',
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

  if (validationMode === "strict" && typeof parsed.content !== "string") {
    throw new CodexStructuredOutputError(
      'Codex tool-calling response must include string "content".',
    );
  }

  const toolCalls = parsed.tool_calls.map((toolCall, index) =>
    normalizeReturnedToolCall(toolCall, index, config, validationMode),
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

  const parameters = isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
  const originalSchema = getOriginalToolSchema(tool) ?? parameters;

  return {
    name: fn.name,
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    parameters,
    validateArgs: createToolArgValidator(fn.name, originalSchema, parameters),
  };
}

function createBasicToolCallingOutputSchema(
  config: CodexToolCallingConfig,
): Record<string, unknown> {
  const requiresToolCalls = config.toolChoice.kind === "any" || config.toolChoice.kind === "tool";
  const requiresFinal = config.toolChoice.kind === "none";
  const toolNames = allowedToolNames(config);

  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "content", "tool_calls"],
    properties: {
      type: {
        type: "string",
        enum: requiresFinal
          ? ["final"]
          : requiresToolCalls
            ? ["tool_calls"]
            : ["final", "tool_calls"],
      },
      content: {
        type: "string",
        description: "Final assistant answer text. Use an empty string when type is tool_calls.",
      },
      tool_calls: {
        type: "array",
        description:
          "Client-side LangChain tool calls to execute. Use this only when type is tool_calls.",
        ...(requiresToolCalls ? { minItems: 1 } : {}),
        ...(requiresFinal ? { maxItems: 0 } : {}),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "args"],
          properties: {
            id: {
              type: "string",
              description: "Stable tool call id generated for this client-side tool call.",
            },
            name: { type: "string", enum: toolNames },
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

function createStrictToolCallItemsSchema(config: CodexToolCallingConfig): Record<string, unknown> {
  const selectedTools = config.tools.filter(
    (tool) => config.toolChoice.kind !== "tool" || tool.name === config.toolChoice.name,
  );
  const usesOneOf = selectedTools.length !== 1;
  const schemas = selectedTools.map((tool, index) => {
    const argsPointer = usesOneOf
      ? `/properties/tool_calls/items/oneOf/${index}/properties/args`
      : "/properties/tool_calls/items/properties/args";

    return {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "args"],
      properties: {
        id: {
          type: "string",
          description: "Stable tool call id generated for this client-side tool call.",
        },
        name: { type: "string", enum: [tool.name] },
        args: {
          ...cloneJsonSchemaForEmbedding(tool.parameters, argsPointer),
          description: `Arguments for the ${tool.name} tool.`,
        },
      },
    };
  });

  if (schemas.length === 1) {
    return schemas[0] ?? {};
  }

  return { oneOf: schemas };
}

function createToolCallingInstructions(
  config: CodexToolCallingConfig,
  validationMode: ToolCallValidationMode,
): string {
  const tools = config.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
  }));
  const argInstruction =
    validationMode === "strict"
      ? "For each tool call, set args to a JSON object, not a JSON-encoded string. The args object must match the selected tool's parameter schema exactly."
      : "For each tool call, set args to a JSON object encoded as a string.";

  return [
    "Experimental LangChain tool-calling mode is active.",
    "The tools below are client-side LangChain tools. Do not execute them with shell commands, MCP, web search, or Codex local tools.",
    'When a tool is needed, return JSON with type "tool_calls" and a tool_calls array. LangChain will execute those tool calls after this turn.',
    'Always include both content and tool_calls. For final answers, set tool_calls to []. For tool-call responses, set content to "" unless useful assistant text is needed.',
    "Every tool call must include an id, name, and args.",
    argInstruction,
    'When no tool is needed, return JSON with type "final" and a content string.',
    "If prior Tool messages are present, use their results to produce a final answer unless another tool call is still required.",
    "Do not repeat a tool call when a prior Tool result already answers the current request.",
    `Validation mode: ${validationMode}.`,
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
  validationMode: ToolCallValidationMode,
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

  const tool = config.tools.find((candidate) => candidate.name === value.name);

  if (tool === undefined) {
    throw new CodexStructuredOutputError(`Codex returned unknown tool "${value.name}".`);
  }

  const args = parseToolCallArgs(value.args, value.name, validationMode);

  if (!isRecord(args)) {
    throw new CodexStructuredOutputError(
      `Codex tool call "${value.name}" must include object "args".`,
    );
  }

  if (validationMode === "strict") {
    tool.validateArgs(args);
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

function parseToolCallArgs(
  value: unknown,
  toolName: string,
  validationMode: ToolCallValidationMode,
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (validationMode === "strict") {
    throw new CodexStructuredOutputError(
      `Codex tool call "${toolName}" must include object "args", not a JSON-encoded string.`,
    );
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

function createToolArgValidator(
  toolName: string,
  originalSchema: unknown,
  parameters: Record<string, unknown>,
): (args: Record<string, unknown>) => void {
  if (isZodLikeSchema(originalSchema)) {
    return (args) => {
      const result = originalSchema.safeParse(args);

      if (!result.success) {
        throw new CodexStructuredOutputError(
          `Codex tool call "${toolName}" args did not match schema: ${formatZodError(result.error)}`,
          { cause: result.error },
        );
      }
    };
  }

  const schema = cloneJsonSchemaForAjv(isRecord(originalSchema) ? originalSchema : parameters);
  let validate: Ajv.ValidateFunction;

  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw new CodexUnsupportedFeatureError(
      `Could not compile JSON Schema for bound tool "${toolName}": ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  return (args) => {
    const valid = validate(args);

    if (valid !== true) {
      throw new CodexStructuredOutputError(
        `Codex tool call "${toolName}" args did not match schema: ${formatAjvErrors(validate.errors)}`,
      );
    }
  };
}

function getOriginalToolSchema(tool: BindToolsInput): unknown {
  if (!isRecord(tool)) {
    return undefined;
  }

  if ("schema" in tool) {
    return tool.schema;
  }

  if (isRecord(tool.function) && "parameters" in tool.function) {
    return tool.function.parameters;
  }

  if ("parameters" in tool) {
    return tool.parameters;
  }

  return undefined;
}

function allowedToolNames(config: CodexToolCallingConfig): string[] {
  if (config.toolChoice.kind === "tool") {
    return [config.toolChoice.name];
  }

  return config.tools.map((tool) => tool.name);
}

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  jsonPointers: true,
  nullable: true,
  removeAdditional: false,
  schemaId: "auto",
  unknownFormats: "ignore",
  useDefaults: false,
});

type ZodLikeSchema = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: unknown } | { success: false; error: unknown };
};

function isZodLikeSchema(schema: unknown): schema is ZodLikeSchema {
  return isRecord(schema) && typeof schema.safeParse === "function";
}

function cloneJsonSchemaForEmbedding(
  schema: Record<string, unknown>,
  basePointer: string,
): Record<string, unknown> {
  return rewriteLocalJsonSchemaRefs(stripJsonSchemaDialect(deepCloneRecord(schema)), basePointer);
}

function cloneJsonSchemaForAjv(schema: Record<string, unknown>): Record<string, unknown> {
  return stripJsonSchemaDialect(deepCloneRecord(schema));
}

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stripJsonSchemaDialect(schema: Record<string, unknown>): Record<string, unknown> {
  visitJsonSchema(schema, (value) => {
    delete value.$schema;
  });

  return schema;
}

function rewriteLocalJsonSchemaRefs(
  schema: Record<string, unknown>,
  basePointer: string,
): Record<string, unknown> {
  visitJsonSchema(schema, (value) => {
    if (typeof value.$ref !== "string") {
      return;
    }

    value.$ref = rewriteLocalJsonSchemaRef(value.$ref, basePointer);
  });

  return schema;
}

function rewriteLocalJsonSchemaRef(ref: string, basePointer: string): string {
  if (ref === "#") {
    return `#${basePointer}`;
  }

  if (ref.startsWith("#/")) {
    return `#${basePointer}${ref.slice(1)}`;
  }

  return ref;
}

function visitJsonSchema(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonSchema(item, visitor);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  visitor(value);

  for (const child of Object.values(value)) {
    visitJsonSchema(child, visitor);
  }
}

function formatZodError(error: unknown): string {
  if (isRecord(error) && Array.isArray(error.issues)) {
    const issues = error.issues
      .filter(isRecord)
      .slice(0, 5)
      .map((issue) => {
        const path = Array.isArray(issue.path) ? formatPath(issue.path) : "/";
        const message = typeof issue.message === "string" ? issue.message : "invalid value";

        return `${path} ${message}`;
      });

    if (issues.length > 0) {
      return issues.join("; ");
    }
  }

  return getErrorMessage(error);
}

function formatAjvErrors(errors: Ajv.ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) {
    return "unknown validation error";
  }

  return errors
    .slice(0, 5)
    .map((error) => {
      if (error.keyword === "required" && isRecord(error.params)) {
        const missing = error.params.missingProperty;
        const basePath = normalizeAjvPath(error.dataPath);

        return `${appendPath(basePath, typeof missing === "string" ? missing : undefined)} is required`;
      }

      if (error.keyword === "additionalProperties" && isRecord(error.params)) {
        const property = error.params.additionalProperty;
        const basePath = normalizeAjvPath(error.dataPath);

        return `${appendPath(basePath, typeof property === "string" ? property : undefined)} is not allowed`;
      }

      return `${normalizeAjvPath(error.dataPath)} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

function normalizeAjvPath(path: string): string {
  return path.length === 0 ? "/" : path;
}

function formatPath(path: unknown[]): string {
  if (path.length === 0) {
    return "/";
  }

  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function appendPath(path: string, segment: string | undefined): string {
  if (segment === undefined || segment.length === 0) {
    return path;
  }

  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");

  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
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
