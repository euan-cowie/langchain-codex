import type { ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Annotation,
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { ToolNode, createReactAgent, toolsCondition } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatCodexSDK, getCodexThreadId } from "../../src/index.js";
import type { CodexClientLike, CodexInput } from "../../src/types.js";

class SequenceFakeThread {
  id: string | null = null;
  runInputs: CodexInput[] = [];
  runOptions: TurnOptions[] = [];

  constructor(private readonly finalResponses: string[]) {}

  run(input: CodexInput, options?: TurnOptions) {
    this.id ??= "thread-langgraph";
    this.runInputs.push(input);
    this.runOptions.push(options ?? {});

    const finalResponse =
      this.finalResponses.shift() ??
      JSON.stringify({
        type: "final",
        content: "No more scripted responses.",
        tool_calls: [],
      });

    return Promise.resolve({
      finalResponse,
      usage: null,
      items: [
        { id: `msg-${this.runInputs.length}`, type: "agent_message" as const, text: finalResponse },
      ],
    });
  }

  runStreamed() {
    throw new Error("Streaming is not used in these compatibility tests.");
  }
}

class SequenceFakeCodexClient {
  readonly thread: SequenceFakeThread;
  startThreadOptions: ThreadOptions[] = [];
  resumeThreadCalls: Array<{ id: string; options: ThreadOptions | undefined }> = [];

  constructor(finalResponses: string[]) {
    this.thread = new SequenceFakeThread(finalResponses);
  }

  startThread(options?: ThreadOptions) {
    this.startThreadOptions.push(options ?? {});
    return this.thread as never;
  }

  resumeThread(id: string, options?: ThreadOptions) {
    this.resumeThreadCalls.push({ id, options });
    this.thread.id = id;
    return this.thread as never;
  }
}

describe("LangGraph tool compatibility", () => {
  it("exposes a conservative profile for tested Codex capabilities", () => {
    const model = new ChatCodexSDK({ codexClient: asCodexClient(new SequenceFakeCodexClient([])) });

    expect(model.profile).toMatchObject({
      structuredOutput: true,
      imageInputs: true,
      imageUrlInputs: false,
      pdfInputs: false,
      audioInputs: false,
      videoInputs: false,
      reasoningOutput: true,
      toolCalling: true,
      toolChoice: true,
    });
  });

  it("routes ChatCodexSDK tool calls through toolsCondition and ToolNode", async () => {
    const client = new SequenceFakeCodexClient([
      toolCallsResponse([{ id: "call-1", name: "multiply", args: { a: 6, b: 7 } }]),
    ]);
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const aiMessage = await modelWithTools.invoke("What is 6 * 7?");

    expect(toolsCondition({ messages: [new HumanMessage("What is 6 * 7?"), aiMessage] })).toBe(
      "tools",
    );

    const toolNode = new ToolNode([multiplyTool]);
    const toolResult = asToolNodeResult(
      await toolNode.invoke({
        messages: [new HumanMessage("What is 6 * 7?"), aiMessage],
      }),
    );

    expect(toolResult.messages).toHaveLength(1);
    expect(toolResult.messages[0]?.tool_call_id).toBe("call-1");
    expect(toolResult.messages[0]?.content).toBe("42");
  });

  it("runs a minimal LangGraph tool loop to a final answer", async () => {
    const client = new SequenceFakeCodexClient([
      toolCallsResponse([{ id: "call-1", name: "multiply", args: { a: 6, b: 7 } }]),
      finalResponse("6 * 7 is 42."),
    ]);
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);
    const toolNode = new ToolNode([multiplyTool]);

    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (state: typeof MessagesAnnotation.State) => {
        const response = await modelWithTools.invoke(state.messages);
        return { messages: [response] };
      })
      .addNode("tools", toolNode)
      .addEdge(START, "agent")
      .addConditionalEdges("agent", toolsCondition, ["tools", END])
      .addEdge("tools", "agent")
      .compile();

    const result = await graph.invoke({
      messages: [new HumanMessage("What is 6 * 7?")],
    });
    const finalMessage = result.messages.at(-1);

    expect(finalMessage).toBeInstanceOf(AIMessage);
    expect(finalMessage?.text).toBe("6 * 7 is 42.");
    expect(client.thread.runInputs[1]).toEqual(
      expect.stringContaining("Tool result (multiply) for call-1:"),
    );
    expect(client.thread.runInputs[1]).toEqual(expect.stringContaining("42"));
  });

  it("runs createReactAgent with ChatCodexSDK bindTools compatibility", async () => {
    const client = new SequenceFakeCodexClient([
      toolCallsResponse([{ id: "call-1", name: "multiply", args: { a: 6, b: 7 } }]),
      finalResponse("6 * 7 is 42."),
    ]);
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const agent = createReactAgent({
      llm: model,
      tools: [multiplyTool],
      prompt: "Use the multiply tool when arithmetic is requested.",
    });

    const result = await agent.invoke({
      messages: [new HumanMessage("What is 6 * 7?")],
    });
    const finalMessage = result.messages.at(-1);

    expect(finalMessage).toBeInstanceOf(AIMessage);
    expect(finalMessage?.text).toBe("6 * 7 is 42.");
    expect(client.thread.runInputs[1]).toEqual(
      expect.stringContaining("Tool result (multiply) for call-1:"),
    );
  });

  it("persists Codex thread ids through checkpointed LangGraph state", async () => {
    const client = new SequenceFakeCodexClient(["First response.", "Second response."]);
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const graph = new StateGraph(CodexThreadAnnotation)
      .addNode("agent", async (state: typeof CodexThreadAnnotation.State) => {
        const inputMessages =
          state.codexThreadId === undefined
            ? state.messages
            : getPendingCodexMessages(state.messages);
        const response = await model.invoke(
          inputMessages,
          state.codexThreadId === undefined ? undefined : { threadId: state.codexThreadId },
        );

        return {
          messages: [response],
          codexThreadId: getCodexThreadId(response) ?? state.codexThreadId,
        };
      })
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: {
        thread_id: "langgraph-checkpoint",
      },
    };

    const first = await graph.invoke(
      { messages: [new HumanMessage("Inspect this repo.")] },
      config,
    );
    const second = await graph.invoke({ messages: [new HumanMessage("Continue.")] }, config);

    expect(first.codexThreadId).toBe("thread-langgraph");
    expect(second.codexThreadId).toBe("thread-langgraph");
    expect(client.startThreadOptions).toHaveLength(1);
    expect(client.resumeThreadCalls).toHaveLength(1);
    expect(client.resumeThreadCalls[0]?.id).toBe("thread-langgraph");
    expect(client.thread.runInputs[1]).toBe("Human:\nContinue.");
  });

  it("applies the same pending-message resume pattern for App Server runtime", async () => {
    const client = new SequenceFakeCodexClient([
      "First App Server response.",
      "Second App Server response.",
    ]);
    const model = new ChatCodexSDK({
      runtime: "app-server",
      codexClient: asCodexClient(client),
    });
    const graph = new StateGraph(CodexThreadAnnotation)
      .addNode("agent", async (state: typeof CodexThreadAnnotation.State) => {
        const inputMessages =
          state.codexThreadId === undefined
            ? state.messages
            : getPendingCodexMessages(state.messages);
        const response = await model.invoke(
          inputMessages,
          state.codexThreadId === undefined ? undefined : { threadId: state.codexThreadId },
        );

        return {
          messages: [response],
          codexThreadId: getCodexThreadId(response) ?? state.codexThreadId,
        };
      })
      .addEdge(START, "agent")
      .addEdge("agent", END)
      .compile({ checkpointer: new MemorySaver() });
    const config = {
      configurable: {
        thread_id: "langgraph-app-server-checkpoint",
      },
    };

    await graph.invoke({ messages: [new HumanMessage("Inspect with App Server.")] }, config);
    const second = await graph.invoke(
      { messages: [new HumanMessage("Continue with App Server.")] },
      config,
    );

    expect(model._llmType()).toBe("codex-app-server");
    expect(model._identifyingParams()).toMatchObject({ runtime: "app-server" });
    expect(second.codexThreadId).toBe("thread-langgraph");
    expect(client.startThreadOptions).toHaveLength(1);
    expect(client.resumeThreadCalls).toHaveLength(1);
    expect(client.resumeThreadCalls[0]?.id).toBe("thread-langgraph");
    expect(client.thread.runInputs[1]).toBe("Human:\nContinue with App Server.");
  });

  it("keeps App Server calls stateless unless a Codex thread id is passed", async () => {
    const client = new SequenceFakeCodexClient(["First response.", "Second response."]);
    const model = new ChatCodexSDK({
      runtime: "app-server",
      codexClient: asCodexClient(client),
    });

    await model.invoke("First call.");
    await model.invoke("Second call.");

    expect(client.startThreadOptions).toHaveLength(2);
    expect(client.resumeThreadCalls).toHaveLength(0);
  });

  it("uses constructor-level Codex thread ids explicitly for App Server runtime", async () => {
    const client = new SequenceFakeCodexClient(["Pinned response."]);
    const model = new ChatCodexSDK({
      runtime: "app-server",
      threadId: "thread-pinned",
      codexClient: asCodexClient(client),
    });

    await model.invoke("Continue pinned thread.");

    expect(client.startThreadOptions).toHaveLength(0);
    expect(client.resumeThreadCalls).toHaveLength(1);
    expect(client.resumeThreadCalls[0]?.id).toBe("thread-pinned");
    expect(client.thread.runInputs[0]).toBe("Human:\nContinue pinned thread.");
  });
});

const CodexThreadAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  codexThreadId: Annotation<string | undefined>(),
});

function getPendingCodexMessages(messages: BaseMessage[]): BaseMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.getType() === "ai") {
      return messages.slice(index + 1);
    }
  }

  return messages;
}

const multiplyTool = tool(({ a, b }: { a: number; b: number }) => String(a * b), {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

function toolCallsResponse(
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): string {
  return JSON.stringify({
    type: "tool_calls",
    content: "",
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
    })),
  });
}

function finalResponse(content: string): string {
  return JSON.stringify({
    type: "final",
    content,
    tool_calls: [],
  });
}

function asCodexClient(client: CodexClientLike): CodexClientLike {
  return client;
}

function asToolNodeResult(value: unknown): { messages: ToolMessage[] } {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("ToolNode did not return a messages array.");
  }

  const messages = value.messages.filter((message): message is ToolMessage =>
    ToolMessage.isInstance(message),
  );

  if (messages.length !== value.messages.length) {
    throw new Error("ToolNode returned a non-tool message.");
  }

  return { messages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
