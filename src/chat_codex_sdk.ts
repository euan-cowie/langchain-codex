import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadItem, ThreadOptions, TurnOptions, Usage } from "@openai/codex-sdk";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { CodexUnsupportedFeatureError, normalizeCodexError } from "./errors.js";
import { convertMessagesToCodexInput } from "./messages.js";
import { createStructuredOutputRunnable } from "./structured_output.js";
import { toCodexResponseMetadata, toTokenUsage, toUsageMetadata } from "./metadata.js";
import type {
  ChatCodexSDKCallOptions,
  ChatCodexSDKFields,
  CodexClientLike,
  CodexThreadLike,
} from "./types.js";

export class ChatCodexSDK extends BaseChatModel<ChatCodexSDKCallOptions, AIMessageChunk> {
  static override lc_name(): string {
    return "ChatCodexSDK";
  }

  override readonly lc_serializable = false;

  model: string | undefined;

  private readonly codexClient: CodexClientLike;
  private readonly clientOptions: ConstructorParameters<typeof Codex>[0];
  private readonly threadOptions: ThreadOptions;
  private readonly defaultThreadId: string | undefined;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(fields: ChatCodexSDKFields = {}) {
    const baseFields = { ...fields };
    if (fields.threadId !== undefined && fields.maxConcurrency === undefined) {
      baseFields.maxConcurrency = 1;
    }

    super(baseFields);

    this.model = fields.model;
    this.defaultThreadId = fields.threadId;
    this.defaultTimeoutMs = fields.timeoutMs;

    this.clientOptions = buildClientOptions(fields);
    this.threadOptions = buildThreadOptions(fields);
    this.codexClient = fields.codexClient ?? new Codex(this.clientOptions);
  }

  override get callKeys(): string[] {
    return [...super.callKeys, "outputSchema", "threadId", "timeoutMs", "includeCodexItems"];
  }

  override _llmType(): string {
    return "codex-sdk";
  }

  override invocationParams(options?: this["ParsedCallOptions"]): Record<string, unknown> {
    return {
      model: this.model,
      workingDirectory: this.threadOptions.workingDirectory,
      sandboxMode: this.threadOptions.sandboxMode,
      approvalPolicy: this.threadOptions.approvalPolicy,
      networkAccessEnabled: this.threadOptions.networkAccessEnabled,
      webSearchMode: this.threadOptions.webSearchMode,
      outputSchema: options?.outputSchema,
    };
  }

  override getLsParams(options: this["ParsedCallOptions"]) {
    const params = {
      ...super.getLsParams(options),
      ls_provider: "codex",
    };

    if (this.model !== undefined) {
      return {
        ...params,
        ls_model_name: this.model,
      };
    }

    return params;
  }

  override _identifyingParams(): Record<string, unknown> {
    return {
      model: this.model,
      workingDirectory: this.threadOptions.workingDirectory,
      sandboxMode: this.threadOptions.sandboxMode,
      approvalPolicy: this.threadOptions.approvalPolicy,
      networkAccessEnabled: this.threadOptions.networkAccessEnabled,
      webSearchMode: this.threadOptions.webSearchMode,
    };
  }

  override _combineLLMOutput(...llmOutputs: Array<Record<string, unknown> | undefined>) {
    const usages = llmOutputs
      .map((output) => output?.codex)
      .filter(isRecord)
      .map((codex) => codex.usage)
      .filter(isUsage);

    if (usages.length === 0) {
      return {};
    }

    const usage = usages.reduce<Usage>(
      (acc, current) => ({
        input_tokens: acc.input_tokens + current.input_tokens,
        cached_input_tokens: acc.cached_input_tokens + current.cached_input_tokens,
        output_tokens: acc.output_tokens + current.output_tokens,
        reasoning_output_tokens: acc.reasoning_output_tokens + current.reasoning_output_tokens,
      }),
      {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    );

    return {
      tokenUsage: toTokenUsage(usage),
      codex: { usage },
    };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    validateCallOptions(options);

    const input = convertMessagesToCodexInput(messages);
    const thread = this.resolveThread(options.threadId);
    const signalContext = createSignalContext(
      options.signal,
      options.timeoutMs ?? this.defaultTimeoutMs,
    );

    try {
      const turn = await thread.run(input, buildTurnOptions(options, signalContext.signal));
      const threadId = thread.id ?? options.threadId ?? this.defaultThreadId ?? null;
      const responseMetadata = toCodexResponseMetadata({
        threadId,
        model: this.model,
        usage: turn.usage,
        items: options.includeCodexItems === false ? undefined : turn.items,
      });
      const usageMetadata = toUsageMetadata(turn.usage);
      const message = new AIMessage(turn.finalResponse);
      message.response_metadata = responseMetadata;
      if (usageMetadata !== undefined) {
        (message as unknown as { usage_metadata?: typeof usageMetadata }).usage_metadata =
          usageMetadata;
      }
      const llmOutput = {
        tokenUsage: toTokenUsage(turn.usage),
        ...responseMetadata,
      };

      return {
        generations: [
          {
            text: turn.finalResponse,
            message,
            generationInfo: responseMetadata,
          },
        ],
        llmOutput,
      };
    } catch (error) {
      throw normalizeCodexError(error);
    } finally {
      signalContext.dispose();
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    validateCallOptions(options);

    const input = convertMessagesToCodexInput(messages);
    const thread = this.resolveThread(options.threadId);
    const signalContext = createSignalContext(
      options.signal,
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const seenAgentTextByItemId = new Map<string, string>();
    const items: ThreadItem[] = [];
    let threadId = thread.id ?? options.threadId ?? this.defaultThreadId ?? null;
    let usage: Usage | null = null;

    try {
      const streamed = await thread.runStreamed(
        input,
        buildTurnOptions(options, signalContext.signal),
      );

      for await (const event of streamed.events) {
        signalContext.signal?.throwIfAborted();

        if (event.type === "thread.started") {
          threadId = event.thread_id;
          continue;
        }

        if (event.type === "turn.failed") {
          throw normalizeCodexError(new Error(event.error.message));
        }

        if (event.type === "error") {
          throw normalizeCodexError(new Error(event.message));
        }

        if (isItemEvent(event)) {
          items.push(event.item);
          const delta = getAgentMessageDelta(event.item, seenAgentTextByItemId);

          if (delta.length > 0) {
            await runManager?.handleLLMNewToken(delta);
            const message = new AIMessageChunk(delta);
            message.response_metadata = toCodexResponseMetadata({
              threadId,
              model: this.model,
            });

            yield new ChatGenerationChunk({
              text: delta,
              message,
            });
          }

          continue;
        }

        if (event.type === "turn.completed") {
          usage = event.usage;
          const usageMetadata = toUsageMetadata(usage);
          const responseMetadata = toCodexResponseMetadata({
            threadId,
            model: this.model,
            usage,
            items: options.includeCodexItems === false ? undefined : items,
          });

          const message = new AIMessageChunk("");
          message.response_metadata = responseMetadata;
          if (usageMetadata !== undefined) {
            (message as unknown as { usage_metadata?: typeof usageMetadata }).usage_metadata =
              usageMetadata;
          }

          yield new ChatGenerationChunk({
            text: "",
            message,
            generationInfo: responseMetadata,
          });
        }
      }
    } catch (error) {
      throw normalizeCodexError(error);
    } finally {
      void usage;
      signalContext.dispose();
    }
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatCodexSDKCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatCodexSDKCallOptions> {
    void tools;
    void kwargs;

    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK does not support LangChain bindTools() in v0.1. Codex has its own local tools and agent runtime; use Codex sandbox/config options instead.",
    );
  }

  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: unknown,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, RunOutput>;

  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: unknown,
    config: StructuredOutputMethodOptions<true>,
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;

  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    outputSchema: unknown,
    config?: StructuredOutputMethodOptions<boolean>,
  ): Runnable<BaseLanguageModelInput, RunOutput | { raw: BaseMessage; parsed: RunOutput }> {
    return createStructuredOutputRunnable(this, outputSchema, config as never);
  }

  private resolveThread(threadId?: string): CodexThreadLike {
    const resolvedThreadId = threadId ?? this.defaultThreadId;

    if (resolvedThreadId !== undefined) {
      return this.codexClient.resumeThread(resolvedThreadId, this.threadOptions);
    }

    return this.codexClient.startThread(this.threadOptions);
  }
}

function buildClientOptions(fields: ChatCodexSDKFields): ConstructorParameters<typeof Codex>[0] {
  const options: ConstructorParameters<typeof Codex>[0] = {};

  if (fields.codexPathOverride !== undefined) {
    options.codexPathOverride = fields.codexPathOverride;
  }

  if (fields.baseUrl !== undefined) {
    options.baseUrl = fields.baseUrl;
  }

  if (fields.apiKey !== undefined) {
    options.apiKey = fields.apiKey;
  }

  if (fields.env !== undefined) {
    options.env = fields.env;
  }

  if (fields.codexConfig !== undefined) {
    options.config = fields.codexConfig;
  }

  return options;
}

function buildThreadOptions(fields: ChatCodexSDKFields): ThreadOptions {
  const options: ThreadOptions = {
    sandboxMode: fields.sandboxMode ?? "read-only",
    networkAccessEnabled: fields.networkAccessEnabled ?? false,
  };

  if (fields.model !== undefined) {
    options.model = fields.model;
  }

  if (fields.workingDirectory !== undefined) {
    options.workingDirectory = fields.workingDirectory;
  }

  if (fields.skipGitRepoCheck !== undefined) {
    options.skipGitRepoCheck = fields.skipGitRepoCheck;
  }

  if (fields.approvalPolicy !== undefined) {
    options.approvalPolicy = fields.approvalPolicy;
  }

  if (fields.modelReasoningEffort !== undefined) {
    options.modelReasoningEffort = fields.modelReasoningEffort;
  }

  if (fields.webSearchMode !== undefined) {
    options.webSearchMode = fields.webSearchMode;
  }

  if (fields.webSearchEnabled !== undefined) {
    options.webSearchEnabled = fields.webSearchEnabled;
  }

  if (fields.additionalDirectories !== undefined) {
    options.additionalDirectories = fields.additionalDirectories;
  }

  return options;
}

function buildTurnOptions(
  options: ChatCodexSDKCallOptions,
  signal: AbortSignal | undefined,
): TurnOptions {
  const turnOptions: TurnOptions = {};

  if (options.outputSchema !== undefined) {
    turnOptions.outputSchema = options.outputSchema;
  }

  if (signal !== undefined) {
    turnOptions.signal = signal;
  }

  return turnOptions;
}

function validateCallOptions(options: ChatCodexSDKCallOptions): void {
  if (options.stop !== undefined && options.stop.length > 0) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK does not support stop sequences in v0.1 because Codex runs through the local agent runtime.",
    );
  }

  const looseOptions = options as Record<string, unknown>;

  if (looseOptions.tools !== undefined || looseOptions.tool_choice !== undefined) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK does not support LangChain provider tool calling in v0.1. Use Codex local tools and sandbox configuration instead.",
    );
  }
}

function createSignalContext(
  sourceSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; dispose: () => void } {
  if (timeoutMs === undefined) {
    if (sourceSignal === undefined) {
      return { dispose: () => undefined };
    }

    return { signal: sourceSignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Codex turn timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const abortFromSource = () => {
    controller.abort(sourceSignal?.reason);
  };

  if (sourceSignal?.aborted) {
    abortFromSource();
  } else {
    sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      sourceSignal?.removeEventListener("abort", abortFromSource);
    },
  };
}

function isItemEvent(
  event: ThreadEvent,
): event is Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }> {
  return (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  );
}

function getAgentMessageDelta(item: ThreadItem, previousTextById: Map<string, string>): string {
  if (item.type !== "agent_message") {
    return "";
  }

  const previousText = previousTextById.get(item.id) ?? "";
  previousTextById.set(item.id, item.text);

  if (item.text.startsWith(previousText)) {
    return item.text.slice(previousText.length);
  }

  return item.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUsage(value: unknown): value is Usage {
  return (
    isRecord(value) &&
    typeof value.input_tokens === "number" &&
    typeof value.cached_input_tokens === "number" &&
    typeof value.output_tokens === "number" &&
    typeof value.reasoning_output_tokens === "number"
  );
}
