import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadItem, ThreadOptions, TurnOptions, Usage } from "@openai/codex-sdk";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { AIMessageChunkFields, AIMessageFields, BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { Runnable } from "@langchain/core/runnables";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  CodexStructuredOutputError,
  CodexUnsupportedFeatureError,
  normalizeCodexError,
} from "./errors.js";
import { convertMessagesToCodexInput } from "./messages.js";
import { createStructuredOutputRunnable } from "./structured_output.js";
import { toCodexResponseMetadata, toTokenUsage, toUsageMetadata } from "./metadata.js";
import {
  contentBlocksFromThreadItem,
  reasoningDeltaBlock,
  shouldUseContentBlocks,
  threadItemsToContentBlocks,
  type CodexContentBlock,
} from "./content_blocks.js";
import type {
  ChatCodexSDKCallOptions,
  ChatCodexSDKFields,
  CodexClientLike,
  CodexThreadLike,
} from "./types.js";
import {
  createCodexToolCallingConfig,
  createToolCallingOutputSchema,
  parseCodexToolCallingResponse,
  prependToolCallingInstructions,
  type CodexToolCallingConfig,
  type CodexToolCallingResult,
  type NormalizedToolChoice,
  type ToolCallValidationMode,
} from "./tool_calling.js";

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
  private readonly defaultToolCallValidation: ToolCallValidationMode;
  private readonly defaultToolCallRepairRetries: number;

  constructor(fields: ChatCodexSDKFields = {}) {
    const baseFields = { ...fields };
    if (fields.threadId !== undefined && fields.maxConcurrency === undefined) {
      baseFields.maxConcurrency = 1;
    }

    super(baseFields);

    this.model = fields.model;
    this.defaultThreadId = fields.threadId;
    this.defaultTimeoutMs = fields.timeoutMs;
    this.defaultToolCallValidation = normalizeToolCallValidation(fields.toolCallValidation);
    this.defaultToolCallRepairRetries = normalizeToolCallRepairRetries(
      fields.toolCallRepairRetries,
    );

    this.clientOptions = buildClientOptions(fields);
    this.threadOptions = buildThreadOptions(fields);
    this.codexClient = fields.codexClient ?? new Codex(this.clientOptions);
  }

  override get callKeys(): string[] {
    return [
      ...super.callKeys,
      "outputSchema",
      "threadId",
      "timeoutMs",
      "includeCodexItems",
      "codexToolCalling",
      "toolCallValidation",
      "toolCallRepairRetries",
    ];
  }

  override _llmType(): string {
    return "codex-sdk";
  }

  /**
   * LangChain capability profile.
   *
   * The tool flags intentionally advertise experimental `bindTools()` compatibility for
   * LangChain/LangGraph `ToolNode` flows. They do not mean the Codex SDK exposes native
   * JavaScript provider-side tool registration.
   */
  override get profile() {
    return {
      structuredOutput: true,
      imageInputs: true,
      imageUrlInputs: false,
      pdfInputs: false,
      audioInputs: false,
      videoInputs: false,
      reasoningOutput: true,
      toolCalling: true,
      toolChoice: true,
    };
  }

  override invocationParams(options?: this["ParsedCallOptions"]): Record<string, unknown> {
    return {
      model: this.model,
      workingDirectory: this.threadOptions.workingDirectory,
      sandboxMode: this.threadOptions.sandboxMode,
      approvalPolicy: this.threadOptions.approvalPolicy,
      modelReasoningEffort: this.threadOptions.modelReasoningEffort,
      networkAccessEnabled: this.threadOptions.networkAccessEnabled,
      webSearchMode: this.threadOptions.webSearchMode,
      outputSchema: options?.outputSchema,
      ...(options?.codexToolCalling === undefined
        ? {}
        : {
            toolCalling: {
              mode: "experimental",
              tools: options.codexToolCalling.tools.map((tool) => tool.name),
              toolChoice: options.codexToolCalling.toolChoice,
              validation: normalizeToolCallValidation(
                options.toolCallValidation ?? this.defaultToolCallValidation,
              ),
              repairRetries: normalizeToolCallRepairRetries(
                options.toolCallRepairRetries ?? this.defaultToolCallRepairRetries,
              ),
            },
          }),
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
      modelReasoningEffort: this.threadOptions.modelReasoningEffort,
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
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    validateCallOptions(options);

    if (options.codexToolCalling !== undefined) {
      return this._generateWithBoundTools(
        messages,
        options as this["ParsedCallOptions"] & { codexToolCalling: CodexToolCallingConfig },
        runManager,
      );
    }

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
      const contentBlocks = threadItemsToContentBlocks(turn.items, turn.finalResponse);
      const message = createCodexMessage({
        text: turn.finalResponse,
        contentBlocks,
        responseMetadata,
        forceV1: shouldForceV1Content(options, this.outputVersion),
      });
      if (usageMetadata !== undefined) {
        (message as unknown as { usage_metadata?: typeof usageMetadata }).usage_metadata =
          usageMetadata;
      }
      await emitCompletedTurnEvents(runManager, threadId, turn.items, turn.usage);
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

    if (options.codexToolCalling !== undefined) {
      const result = await this._generate(messages, options, runManager);
      const generation = result.generations[0];

      if (generation !== undefined) {
        const chunkFields = {
          text: generation.text,
          message: aiMessageToChunk(generation.message as AIMessage),
        };
        const chunk = new ChatGenerationChunk(
          generation.generationInfo === undefined
            ? chunkFields
            : { ...chunkFields, generationInfo: generation.generationInfo },
        );

        await runManager?.handleLLMNewToken(
          generation.text,
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk },
        );

        yield chunk;
      }

      return;
    }

    const input = convertMessagesToCodexInput(messages);
    const thread = this.resolveThread(options.threadId);
    const signalContext = createSignalContext(
      options.signal,
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const seenAgentTextByItemId = new Map<string, string>();
    const seenReasoningTextByItemId = new Map<string, string>();
    const itemOrder: string[] = [];
    const latestItemById = new Map<string, ThreadItem>();
    let threadId = thread.id ?? options.threadId ?? this.defaultThreadId ?? null;
    let usage: Usage | null = null;

    try {
      const streamed = await thread.runStreamed(
        input,
        buildTurnOptions(options, signalContext.signal),
      );

      for await (const event of streamed.events) {
        signalContext.signal?.throwIfAborted();
        await emitCodexStreamEvent(runManager, event, threadId);

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
          recordStreamItem(event.item, itemOrder, latestItemById);
          const delta = getAgentMessageDelta(event.item, seenAgentTextByItemId);

          if (delta.length > 0) {
            const message = new AIMessageChunk(delta);
            message.response_metadata = toCodexResponseMetadata({
              threadId,
              model: this.model,
            });
            const chunk = new ChatGenerationChunk({
              text: delta,
              message,
            });

            await runManager?.handleLLMNewToken(delta, undefined, undefined, undefined, undefined, {
              chunk,
            });

            yield chunk;
          }

          const eventBlocks = contentBlocksFromStreamItemEvent(event, seenReasoningTextByItemId);
          if (eventBlocks.length > 0) {
            const chunk = createContentBlockChunk(eventBlocks, threadId, this.model);

            await runManager?.handleLLMNewToken("", undefined, undefined, undefined, undefined, {
              chunk,
            });

            yield chunk;
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
            items:
              options.includeCodexItems === false
                ? undefined
                : getLatestStreamItems(itemOrder, latestItemById),
          });

          const message = new AIMessageChunk([]);
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
    if (tools.length === 0) {
      return createBoundRunnable(this, kwargs);
    }

    const codexToolCalling = createCodexToolCallingConfig(tools, kwargs);

    return createBoundRunnable(this, {
      ...kwargs,
      codexToolCalling,
    });
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

  private async _generateWithBoundTools(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"] & { codexToolCalling: CodexToolCallingConfig },
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const validationMode = normalizeToolCallValidation(
      options.toolCallValidation ?? this.defaultToolCallValidation,
    );
    const repairRetries = normalizeToolCallRepairRetries(
      options.toolCallRepairRetries ?? this.defaultToolCallRepairRetries,
    );
    const outputSchema = createToolCallingOutputSchema(options.codexToolCalling, validationMode);
    const input = prependToolCallingInstructions(
      convertMessagesToCodexInput(messages),
      options.codexToolCalling,
      validationMode,
    );
    const thread = this.resolveThread(options.threadId);
    const signalContext = createSignalContext(
      options.signal,
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const usages: Usage[] = [];
    const validationErrors: ToolCallingValidationSummary[] = [];
    let attempt = 0;
    let nextInput = input;

    try {
      while (true) {
        attempt += 1;
        signalContext.signal?.throwIfAborted();

        const turn = await thread.run(
          nextInput,
          buildTurnOptions(
            {
              ...options,
              outputSchema,
            },
            signalContext.signal,
          ),
        );
        const threadId = thread.id ?? options.threadId ?? this.defaultThreadId ?? null;

        if (isUsage(turn.usage)) {
          usages.push(turn.usage);
        }

        try {
          const toolCallingResult = parseCodexToolCallingResponse(
            turn.finalResponse,
            options.codexToolCalling,
            { validationMode },
          );
          const aggregatedUsage = aggregateUsages(usages);
          const toolCallingTrace = createToolCallingTrace({
            validationMode,
            toolChoice: options.codexToolCalling.toolChoice,
            repairRetries,
            attempts: attempt,
            validationErrors,
          });
          const responseMetadata = withToolCallingTrace(
            toCodexResponseMetadata({
              threadId,
              model: this.model,
              usage: aggregatedUsage,
              items: options.includeCodexItems === false ? undefined : turn.items,
            }),
            toolCallingTrace,
          );
          const usageMetadata = toUsageMetadata(aggregatedUsage);
          const message = createToolCallingMessage(toolCallingResult, responseMetadata);
          if (usageMetadata !== undefined) {
            (message as unknown as { usage_metadata?: typeof usageMetadata }).usage_metadata =
              usageMetadata;
          }
          await emitCompletedTurnEvents(runManager, threadId, turn.items, turn.usage);
          await emitToolCallingAttemptEvent(runManager, "succeeded", threadId, {
            attempt,
            validationMode,
            toolChoice: serializeToolChoice(options.codexToolCalling.toolChoice),
            repairAttempt: attempt > 1,
            resultType: toolCallingResult.type,
          });
          await emitToolCallingCompletedEvent(runManager, threadId, toolCallingTrace);
          const llmOutput = {
            tokenUsage: toTokenUsage(aggregatedUsage),
            ...responseMetadata,
          };

          return {
            generations: [
              {
                text: message.text,
                message,
                generationInfo: responseMetadata,
              },
            ],
            llmOutput,
          };
        } catch (error) {
          if (!(error instanceof CodexStructuredOutputError)) {
            throw error;
          }

          const summary = summarizeValidationError(error);
          validationErrors.push({ attempt, summary });
          await emitToolCallingAttemptEvent(runManager, "failed", threadId, {
            attempt,
            validationMode,
            toolChoice: serializeToolChoice(options.codexToolCalling.toolChoice),
            repairAttempt: attempt > 1,
            validationError: summary,
            exhausted: attempt - 1 >= repairRetries,
          });

          if (attempt - 1 >= repairRetries) {
            throw error;
          }

          nextInput = createToolCallingRepairPrompt(summary);
        }
      }
    } catch (error) {
      throw normalizeCodexError(error);
    } finally {
      signalContext.dispose();
    }
  }

  private resolveThread(threadId?: string): CodexThreadLike {
    const resolvedThreadId = threadId ?? this.defaultThreadId;

    if (resolvedThreadId !== undefined) {
      return this.codexClient.resumeThread(resolvedThreadId, this.threadOptions);
    }

    return this.codexClient.startThread(this.threadOptions);
  }
}

function createToolCallingMessage(
  result: CodexToolCallingResult,
  responseMetadata: Record<string, unknown>,
): AIMessage {
  const fields: AIMessageFields = {
    content: result.content,
    response_metadata: responseMetadata,
  };

  if (result.type === "tool_calls") {
    fields.tool_calls = result.toolCalls;
  }

  return new AIMessage(fields);
}

type ToolCallingValidationSummary = {
  attempt: number;
  summary: string;
};

type ToolCallingTrace = {
  validationMode: ToolCallValidationMode;
  toolChoice: string | { kind: "tool"; name: string };
  repairRetries: number;
  attempts: number;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  validationErrorSummaries: ToolCallingValidationSummary[];
};

function createToolCallingTrace({
  validationMode,
  toolChoice,
  repairRetries,
  attempts,
  validationErrors,
}: {
  validationMode: ToolCallValidationMode;
  toolChoice: NormalizedToolChoice;
  repairRetries: number;
  attempts: number;
  validationErrors: ToolCallingValidationSummary[];
}): ToolCallingTrace {
  return {
    validationMode,
    toolChoice: serializeToolChoice(toolChoice),
    repairRetries,
    attempts,
    repairAttempted: attempts > 1,
    repairSucceeded: attempts > 1 && validationErrors.length > 0,
    validationErrorSummaries: validationErrors,
  };
}

function withToolCallingTrace<T extends Record<string, unknown>>(
  responseMetadata: T,
  trace: ToolCallingTrace,
): T {
  const codex = isRecord(responseMetadata.codex) ? responseMetadata.codex : {};

  return {
    ...responseMetadata,
    codex: {
      ...codex,
      toolCalling: trace,
    },
  };
}

function serializeToolChoice(
  choice: NormalizedToolChoice,
): string | { kind: "tool"; name: string } {
  if (choice.kind === "tool") {
    return { kind: "tool", name: choice.name };
  }

  return choice.kind;
}

function createToolCallingRepairPrompt(validationSummary: string): string {
  return [
    "Your previous response did not satisfy the LangChain tool-calling JSON protocol.",
    "Return only corrected JSON that matches the same output schema for this turn.",
    "Do not include markdown fences or explanatory text.",
    `Validation error: ${validationSummary}`,
  ].join("\n");
}

function summarizeValidationError(error: Error): string {
  const oneLine = error.message.replace(/\s+/g, " ").trim();

  return oneLine.length <= 500 ? oneLine : `${oneLine.slice(0, 497)}...`;
}

async function emitToolCallingAttemptEvent(
  runManager: CallbackManagerForLLMRun | undefined,
  status: "succeeded" | "failed",
  threadId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
  await runManager?.handleCustomEvent(
    `codex.tool_calling.attempt.${status}`,
    withThreadId(data, threadId),
  );
}

async function emitToolCallingCompletedEvent(
  runManager: CallbackManagerForLLMRun | undefined,
  threadId: string | null,
  trace: ToolCallingTrace,
): Promise<void> {
  await runManager?.handleCustomEvent(
    "codex.tool_calling.completed",
    withThreadId({ toolCalling: trace }, threadId),
  );
}

function aiMessageToChunk(message: AIMessage): AIMessageChunk {
  const fields: AIMessageChunkFields = {
    content: message.content,
    response_metadata: message.response_metadata,
  };

  if (message.tool_calls !== undefined) {
    fields.tool_calls = message.tool_calls;
  }

  if (message.invalid_tool_calls !== undefined) {
    fields.invalid_tool_calls = message.invalid_tool_calls;
  }

  if (message.usage_metadata !== undefined) {
    fields.usage_metadata = message.usage_metadata;
  }

  return new AIMessageChunk(fields);
}

function createBoundRunnable(
  model: ChatCodexSDK,
  boundOptions: Partial<ChatCodexSDKCallOptions> | undefined,
): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatCodexSDKCallOptions> {
  return new ChatCodexSDKBoundToolRunnable(model, boundOptions);
}

class ChatCodexSDKBoundToolRunnable extends Runnable<
  BaseLanguageModelInput,
  AIMessageChunk,
  ChatCodexSDKCallOptions
> {
  override lc_namespace = ["langchain", "chat_models", "codex-sdk", "bind_tools"];

  constructor(
    private readonly model: ChatCodexSDK,
    private readonly boundOptions: Partial<ChatCodexSDKCallOptions> | undefined,
  ) {
    super();
  }

  override async invoke(
    input: BaseLanguageModelInput,
    options?: Partial<ChatCodexSDKCallOptions>,
  ): Promise<AIMessageChunk> {
    return this.model.invoke(input, mergeBoundCallOptions(this.boundOptions, options));
  }

  override async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<ChatCodexSDKCallOptions>,
  ): AsyncGenerator<AIMessageChunk> {
    const stream = await this.model.stream(
      input,
      mergeBoundCallOptions(this.boundOptions, options),
    );

    for await (const chunk of stream) {
      yield chunk;
    }
  }
}

function mergeBoundCallOptions(
  boundOptions: Partial<ChatCodexSDKCallOptions> | undefined,
  runtimeOptions: Partial<ChatCodexSDKCallOptions> | undefined,
): Partial<ChatCodexSDKCallOptions> {
  const merged = {
    ...(boundOptions ?? {}),
    ...(runtimeOptions ?? {}),
  };

  if (boundOptions?.codexToolCalling !== undefined) {
    merged.codexToolCalling = boundOptions.codexToolCalling;
  }

  return merged;
}

function createCodexMessage({
  text,
  contentBlocks,
  responseMetadata,
  forceV1,
}: {
  text: string;
  contentBlocks: CodexContentBlock[];
  responseMetadata: Record<string, unknown>;
  forceV1: boolean;
}): AIMessage {
  if (shouldUseContentBlocks(contentBlocks, text, forceV1)) {
    const fields: AIMessageFields = {
      contentBlocks,
      response_metadata: responseMetadata,
    };

    return new AIMessage(fields);
  }

  const message = new AIMessage(text);
  message.response_metadata = responseMetadata;
  return message;
}

function createContentBlockChunk(
  contentBlocks: CodexContentBlock[],
  threadId: string | null,
  model: string | undefined,
): ChatGenerationChunk {
  const responseMetadata = {
    ...toCodexResponseMetadata({
      threadId,
      model,
    }),
    output_version: "v1",
  };
  const message = new AIMessageChunk({
    contentBlocks,
    response_metadata: responseMetadata,
  });

  return new ChatGenerationChunk({
    text: "",
    message,
  });
}

function shouldForceV1Content(
  options: ChatCodexSDKCallOptions,
  defaultOutputVersion: string | undefined,
): boolean {
  return (
    (options as { outputVersion?: string }).outputVersion === "v1" || defaultOutputVersion === "v1"
  );
}

function contentBlocksFromStreamItemEvent(
  event: Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>,
  seenReasoningTextByItemId: Map<string, string>,
): CodexContentBlock[] {
  if (event.item.type === "agent_message") {
    return [];
  }

  if (event.item.type === "reasoning") {
    return reasoningDeltaBlock(event.item, seenReasoningTextByItemId);
  }

  const phase = event.type.slice("item.".length) as "started" | "updated" | "completed";
  return contentBlocksFromThreadItem(event.item, phase);
}

async function emitCodexStreamEvent(
  runManager: CallbackManagerForLLMRun | undefined,
  event: ThreadEvent,
  threadId: string | null,
): Promise<void> {
  const customEvent = codexCustomEventFromThreadEvent(event, threadId);
  if (customEvent === undefined) {
    return;
  }

  await runManager?.handleCustomEvent(customEvent.name, customEvent.data);
}

async function emitCompletedTurnEvents(
  runManager: CallbackManagerForLLMRun | undefined,
  threadId: string | null,
  items: ThreadItem[],
  usage: Usage | null,
): Promise<void> {
  if (runManager === undefined) {
    return;
  }

  for (const item of items) {
    await runManager.handleCustomEvent(
      `codex.${item.type}.completed`,
      withThreadId({ item }, threadId),
    );
  }

  await runManager.handleCustomEvent("codex.turn.completed", withThreadId({ usage }, threadId));
}

function codexCustomEventFromThreadEvent(
  event: ThreadEvent,
  currentThreadId: string | null,
): { name: string; data: Record<string, unknown> } | undefined {
  switch (event.type) {
    case "thread.started":
      return {
        name: "codex.thread.started",
        data: { threadId: event.thread_id },
      };
    case "turn.started":
      return {
        name: "codex.turn.started",
        data: withThreadId({}, currentThreadId),
      };
    case "turn.completed":
      return {
        name: "codex.turn.completed",
        data: withThreadId({ usage: event.usage }, currentThreadId),
      };
    case "turn.failed":
      return {
        name: "codex.turn.failed",
        data: withThreadId({ error: event.error }, currentThreadId),
      };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const phase = event.type.slice("item.".length);
      return {
        name: `codex.${event.item.type}.${phase}`,
        data: withThreadId({ item: event.item }, currentThreadId),
      };
    }
    case "error":
      return {
        name: "codex.error",
        data: withThreadId({ message: event.message }, currentThreadId),
      };
    default:
      return undefined;
  }
}

function withThreadId(
  data: Record<string, unknown>,
  threadId: string | null,
): Record<string, unknown> {
  if (threadId === null) {
    return data;
  }

  return {
    ...data,
    threadId,
  };
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

function normalizeToolCallValidation(
  value: ToolCallValidationMode | undefined,
): ToolCallValidationMode {
  if (value === undefined) {
    return "strict";
  }

  if (value === "strict" || value === "basic") {
    return value;
  }

  throw new CodexUnsupportedFeatureError('toolCallValidation must be either "strict" or "basic".');
}

function normalizeToolCallRepairRetries(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }

  if (Number.isInteger(value) && value >= 0 && value <= 3) {
    return value;
  }

  throw new CodexUnsupportedFeatureError(
    "toolCallRepairRetries must be an integer from 0 through 3.",
  );
}

function validateCallOptions(options: ChatCodexSDKCallOptions): void {
  if (options.stop !== undefined && options.stop.length > 0) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK does not support stop sequences because Codex runs through the local agent runtime.",
    );
  }

  if (options.codexToolCalling !== undefined && options.outputSchema !== undefined) {
    throw new CodexUnsupportedFeatureError(
      "ChatCodexSDK.bindTools() cannot be combined with outputSchema or withStructuredOutput() because experimental tool calling uses Codex outputSchema internally.",
    );
  }

  const looseOptions = options as Record<string, unknown>;

  if (looseOptions.tools !== undefined) {
    throw new CodexUnsupportedFeatureError(
      "Pass LangChain tools through ChatCodexSDK.bindTools() instead of raw call option tools.",
    );
  }

  if (looseOptions.tool_choice !== undefined && options.codexToolCalling === undefined) {
    throw new CodexUnsupportedFeatureError(
      "Pass tool_choice through ChatCodexSDK.bindTools(tools, { tool_choice }) so it can be applied by the experimental Codex tool-calling adapter.",
    );
  }

  normalizeToolCallValidation(options.toolCallValidation);
  normalizeToolCallRepairRetries(options.toolCallRepairRetries);
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

function recordStreamItem(
  item: ThreadItem,
  itemOrder: string[],
  latestItemById: Map<string, ThreadItem>,
): void {
  if (!latestItemById.has(item.id)) {
    itemOrder.push(item.id);
  }

  latestItemById.set(item.id, item);
}

function getLatestStreamItems(
  itemOrder: string[],
  latestItemById: Map<string, ThreadItem>,
): ThreadItem[] {
  return itemOrder
    .map((itemId) => latestItemById.get(itemId))
    .filter((item): item is ThreadItem => item !== undefined);
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

function aggregateUsages(usages: Usage[]): Usage | null {
  if (usages.length === 0) {
    return null;
  }

  return usages.reduce<Usage>(
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
