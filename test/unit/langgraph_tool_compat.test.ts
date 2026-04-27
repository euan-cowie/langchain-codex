import type { ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatCodexSDK } from "../../src/index.js";
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

  constructor(finalResponses: string[]) {
    this.thread = new SequenceFakeThread(finalResponses);
  }

  startThread(options?: ThreadOptions) {
    this.startThreadOptions.push(options ?? {});
    return this.thread as never;
  }

  resumeThread() {
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
});

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
      args: JSON.stringify(toolCall.args),
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

function asCodexClient(client: SequenceFakeCodexClient): CodexClientLike {
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
