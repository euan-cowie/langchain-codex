import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { toJSONSchema } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CodexStructuredOutputError, CodexUnsupportedFeatureError } from "./errors.js";
import type { ChatCodexSDK, ChatCodexSDKCallOptions } from "./index.js";

type ZodLikeSchema<RunOutput> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: RunOutput } | { success: false; error: unknown };
};

type StructuredOutputConfig<IncludeRaw extends boolean = boolean> = {
  name?: string;
  method?: string;
  includeRaw?: IncludeRaw;
  strict?: boolean;
};

export function createStructuredOutputRunnable<RunOutput extends Record<string, unknown>>(
  model: ChatCodexSDK,
  schema: unknown,
  config: StructuredOutputConfig<false> | undefined,
): Runnable<BaseLanguageModelInput, RunOutput>;

export function createStructuredOutputRunnable<RunOutput extends Record<string, unknown>>(
  model: ChatCodexSDK,
  schema: unknown,
  config: StructuredOutputConfig<true>,
): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;

export function createStructuredOutputRunnable<RunOutput extends Record<string, unknown>>(
  model: ChatCodexSDK,
  schema: unknown,
  config?: StructuredOutputConfig<boolean>,
): Runnable<BaseLanguageModelInput, RunOutput | { raw: BaseMessage; parsed: RunOutput }> {
  if (config?.method === "functionCalling") {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK.withStructuredOutput() uses Codex outputSchema. LangChain function-calling structured output is not supported.",
    );
  }

  if (config?.method !== undefined && !["jsonSchema", "jsonMode"].includes(config.method)) {
    throw new CodexUnsupportedFeatureError(
      `Unsupported structured output method "${config.method}". Use "jsonSchema" for Codex-native outputSchema.`,
    );
  }

  const outputSchema = toCodexOutputSchema(schema, config?.name);
  const validator = isZodLikeSchema<RunOutput>(schema) ? schema : undefined;

  return RunnableLambda.from<
    BaseLanguageModelInput,
    RunOutput | { raw: BaseMessage; parsed: RunOutput }
  >(async (input, options) => {
    const raw = await model.invoke(input, {
      ...(options as Partial<ChatCodexSDKCallOptions>),
      outputSchema,
      ls_structured_output_format: {
        kwargs: { method: "jsonSchema" },
        schema: outputSchema,
      },
    });

    const parsedJson = parseMessageJson(raw);
    const parsed =
      validator === undefined ? (parsedJson as RunOutput) : validateZod(validator, parsedJson);

    if (config?.includeRaw) {
      return { raw, parsed };
    }

    return parsed;
  });
}

export function toCodexOutputSchema(schema: unknown, name?: string): Record<string, unknown> {
  let jsonSchema: Record<string, unknown>;

  if (isZodV4Schema(schema)) {
    jsonSchema = toJSONSchema(schema, { target: "draft-07" });
  } else if (isZodLikeSchema(schema)) {
    jsonSchema = zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0], {
      target: "openAi",
    });
  } else if (isRecord(schema)) {
    jsonSchema = { ...schema };
  } else {
    throw new CodexStructuredOutputError(
      "Structured output requires a JSON Schema object or a Zod schema.",
    );
  }

  if (name !== undefined && typeof jsonSchema.title !== "string") {
    jsonSchema.title = name;
  }

  return jsonSchema;
}

export function parseMessageJson(message: BaseMessage): unknown {
  const text = message.text.trim();

  if (text.length === 0) {
    throw new CodexStructuredOutputError("Codex returned an empty structured output response.");
  }

  try {
    return JSON.parse(stripMarkdownJsonFence(text));
  } catch (error) {
    throw new CodexStructuredOutputError(
      `Codex returned malformed structured output JSON: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

function validateZod<RunOutput>(schema: ZodLikeSchema<RunOutput>, value: unknown): RunOutput {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new CodexStructuredOutputError(
      `Codex structured output did not match the requested schema: ${getErrorMessage(result.error)}`,
      { cause: result.error },
    );
  }

  return result.data;
}

function stripMarkdownJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function isZodLikeSchema<RunOutput>(schema: unknown): schema is ZodLikeSchema<RunOutput> {
  return isRecord(schema) && typeof schema.safeParse === "function";
}

function isZodV4Schema(schema: unknown): schema is Parameters<typeof toJSONSchema>[0] {
  return isRecord(schema) && "_zod" in schema && typeof schema.safeParse === "function";
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
