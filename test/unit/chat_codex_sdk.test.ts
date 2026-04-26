import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { ThreadItem } from "@openai/codex-sdk";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatCodexSDK, CodexUnsupportedFeatureError } from "../../src/index.js";
import type { CodexClientLike, CodexInput } from "../../src/types.js";

const usage = {
  input_tokens: 10,
  cached_input_tokens: 2,
  output_tokens: 5,
  reasoning_output_tokens: 1,
};

class FakeThread {
  id: string | null;
  runInputs: CodexInput[] = [];
  runOptions: TurnOptions[] = [];
  streamInputs: CodexInput[] = [];
  streamOptions: TurnOptions[] = [];
  finalResponse = "Codex response";
  items: ThreadItem[] | undefined;
  events: ThreadEvent[] = [];

  constructor(id: string | null) {
    this.id = id;
  }

  run(input: CodexInput, options?: TurnOptions) {
    this.id ??= "thread-new";
    this.runInputs.push(input);
    this.runOptions.push(options ?? {});

    return Promise.resolve({
      finalResponse: this.finalResponse,
      usage,
      items: this.items ?? [
        { id: "msg-1", type: "agent_message" as const, text: this.finalResponse },
      ],
    });
  }

  runStreamed(input: CodexInput, options?: TurnOptions) {
    this.id ??= "thread-new";
    this.streamInputs.push(input);
    this.streamOptions.push(options ?? {});

    return Promise.resolve({
      events: toAsyncGenerator(this.events),
    });
  }
}

class FakeCodexClient {
  startThreadOptions: ThreadOptions[] = [];
  resumeThreadCalls: Array<{ id: string; options: ThreadOptions | undefined }> = [];
  startedThread = new FakeThread(null);
  resumedThread = new FakeThread("thread-existing");

  startThread(options?: ThreadOptions) {
    this.startThreadOptions.push(options ?? {});
    return this.startedThread as never;
  }

  resumeThread(id: string, options?: ThreadOptions) {
    this.resumeThreadCalls.push({ id, options });
    this.resumedThread.id = id;
    return this.resumedThread as never;
  }
}

describe("ChatCodexSDK", () => {
  it("invokes Codex through a new thread by default", async () => {
    const client = new FakeCodexClient();
    const model = new ChatCodexSDK({
      model: "gpt-5.4",
      workingDirectory: "/repo",
      codexClient: asCodexClient(client),
    });

    const response = await model.invoke("Review this repo.");

    expect(response.content).toBe("Codex response");
    expect(response.usage_metadata).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(response.response_metadata.codex).toMatchObject({
      threadId: "thread-new",
      model: "gpt-5.4",
      usage,
    });
    expect(client.startThreadOptions[0]).toMatchObject({
      model: "gpt-5.4",
      workingDirectory: "/repo",
      sandboxMode: "read-only",
      networkAccessEnabled: false,
    });
    expect(client.startedThread.runInputs[0]).toBe("Human:\nReview this repo.");
  });

  it("surfaces Codex runtime items as LangChain content blocks", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "Tests passed.";
    client.startedThread.items = [
      { id: "reason-1", type: "reasoning", text: "Need to inspect the test output." },
      {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "4 passed",
        exit_code: 0,
        status: "completed",
      },
      { id: "msg-1", type: "agent_message", text: "Tests passed." },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const response = await model.invoke("Run the tests.");

    expect(response.text).toBe("Tests passed.");
    expect(response.response_metadata.output_version).toBe("v1");
    expect(response.contentBlocks).toMatchObject([
      {
        id: "reason-1",
        type: "reasoning",
        reasoning: "Need to inspect the test output.",
      },
      {
        id: "cmd-1",
        type: "server_tool_call",
        name: "codex_shell",
        args: { command: "npm test" },
      },
      {
        type: "server_tool_call_result",
        toolCallId: "cmd-1",
        status: "success",
        output: {
          command: "npm test",
          output: "4 passed",
          exitCode: 0,
        },
      },
      {
        type: "text",
        text: "Tests passed.",
      },
    ]);
  });

  it("allows returned runtime-rich messages to be used as follow-up history", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "Tests passed.";
    client.startedThread.items = [
      { id: "reason-1", type: "reasoning", text: "Need to inspect the test output." },
      {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "4 passed",
        exit_code: 0,
        status: "completed",
      },
      { id: "msg-1", type: "agent_message", text: "Tests passed." },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const first = await model.invoke("Run the tests.");
    client.startedThread.finalResponse = "Continuing.";
    client.startedThread.items = [{ id: "msg-2", type: "agent_message", text: "Continuing." }];

    await model.invoke([new HumanMessage("Previous task."), first, new HumanMessage("Continue.")]);

    expect(client.startedThread.runInputs[1]).toBe(
      [
        "Human:",
        "Previous task.",
        "",
        "Assistant:",
        "Tests passed.",
        "",
        "Human:",
        "Continue.",
      ].join("\n"),
    );
  });

  it("maps MCP, web search, file change, todo, and error items to standard blocks", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "Runtime activity captured.";
    client.startedThread.items = [
      {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "package.json" },
        result: {
          content: [],
          structured_content: { packageName: "langchain-codex" },
        },
        status: "completed",
      },
      {
        id: "web-1",
        type: "web_search",
        query: "langchain codex sdk",
      },
      {
        id: "file-1",
        type: "file_change",
        changes: [{ path: "README.md", kind: "update" }],
        status: "completed",
      },
      {
        id: "todo-1",
        type: "todo_list",
        items: [{ text: "Inspect package metadata", completed: true }],
      },
      {
        id: "error-1",
        type: "error",
        message: "A recoverable warning was emitted.",
      },
      { id: "msg-1", type: "agent_message", text: "Runtime activity captured." },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const response = await model.invoke("Exercise runtime events.");

    expect(response.contentBlocks).toMatchObject([
      {
        id: "mcp-1",
        type: "server_tool_call",
        name: "filesystem.read_file",
        args: { path: "package.json" },
      },
      {
        type: "server_tool_call_result",
        name: "filesystem.read_file",
        toolCallId: "mcp-1",
        status: "success",
        output: {
          content: [],
          structuredContent: { packageName: "langchain-codex" },
        },
      },
      {
        id: "web-1",
        type: "server_tool_call",
        name: "web_search",
        args: { query: "langchain codex sdk" },
      },
      {
        id: "file-1",
        type: "non_standard",
        value: {
          type: "file_change",
          changes: [{ path: "README.md", kind: "update" }],
          status: "completed",
        },
      },
      {
        id: "todo-1",
        type: "non_standard",
        value: {
          type: "todo_list",
          items: [{ text: "Inspect package metadata", completed: true }],
        },
      },
      {
        id: "error-1",
        type: "non_standard",
        value: {
          type: "error",
          message: "A recoverable warning was emitted.",
        },
      },
      { type: "text", text: "Runtime activity captured." },
    ]);
  });

  it("keeps standard content blocks when raw Codex items are suppressed", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "Tests passed.";
    client.startedThread.items = [
      { id: "reason-1", type: "reasoning", text: "Need to inspect the test output." },
      {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "4 passed",
        exit_code: 0,
        status: "completed",
      },
      { id: "msg-1", type: "agent_message", text: "Tests passed." },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const response = await model.invoke("Run the tests.", { includeCodexItems: false });

    expect(response.response_metadata.codex).not.toHaveProperty("items");
    expect(response.contentBlocks).toMatchObject([
      {
        id: "reason-1",
        type: "reasoning",
        reasoning: "Need to inspect the test output.",
      },
      {
        id: "cmd-1",
        type: "server_tool_call",
        name: "codex_shell",
        args: { command: "npm test" },
      },
      {
        type: "server_tool_call_result",
        toolCallId: "cmd-1",
        status: "success",
      },
      { type: "text", text: "Tests passed." },
    ]);
  });

  it("maps failed command and MCP items to error tool results", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "Failures captured.";
    client.startedThread.items = [
      {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "1 failed",
        exit_code: 1,
        status: "failed",
      },
      {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "missing.txt" },
        error: { message: "File not found" },
        status: "failed",
      },
      { id: "msg-1", type: "agent_message", text: "Failures captured." },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const response = await model.invoke("Exercise failure mapping.");

    expect(response.contentBlocks).toMatchObject([
      {
        id: "cmd-1",
        type: "server_tool_call",
        name: "codex_shell",
        args: { command: "npm test" },
      },
      {
        type: "server_tool_call_result",
        name: "codex_shell",
        toolCallId: "cmd-1",
        status: "error",
        output: {
          command: "npm test",
          output: "1 failed",
          exitCode: 1,
        },
      },
      {
        id: "mcp-1",
        type: "server_tool_call",
        name: "filesystem.read_file",
        args: { path: "missing.txt" },
      },
      {
        type: "server_tool_call_result",
        name: "filesystem.read_file",
        toolCallId: "mcp-1",
        status: "error",
        output: { error: "File not found" },
      },
      { type: "text", text: "Failures captured." },
    ]);
  });

  it("resumes an explicit thread when provided", async () => {
    const client = new FakeCodexClient();
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    await model.invoke("Continue.", { threadId: "thread-123" });

    expect(client.resumeThreadCalls[0]?.id).toBe("thread-123");
    expect(client.resumedThread.runInputs[0]).toBe("Human:\nContinue.");
  });

  it("passes structured output schemas to Codex turn options", async () => {
    const client = new FakeCodexClient();
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    };

    await model.invoke("Summarize.", { outputSchema });

    expect(client.startedThread.runOptions[0]?.outputSchema).toBe(outputSchema);
  });

  it("streams Codex agent message deltas", async () => {
    const client = new FakeCodexClient();
    client.startedThread.events = [
      { type: "thread.started", thread_id: "thread-stream" },
      {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hello" },
      },
      {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hello world" },
      },
      { type: "turn.completed", usage },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const stream = await model.stream("Say hello.");
    let text = "";
    let finalThreadId: unknown;

    for await (const chunk of stream) {
      text += chunk.text;
      finalThreadId = (chunk.response_metadata.codex as { threadId?: string } | undefined)
        ?.threadId;
    }

    expect(text).toBe("Hello world");
    expect(finalThreadId).toBe("thread-stream");
  });

  it("streams Codex runtime content blocks and custom events", async () => {
    const client = new FakeCodexClient();
    client.startedThread.events = [
      { type: "thread.started", thread_id: "thread-stream" },
      { type: "turn.started" },
      {
        type: "item.updated",
        item: { id: "reason-1", type: "reasoning", text: "Need tests." },
      },
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "4 passed",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Done" },
      },
      { type: "turn.completed", usage },
    ];
    const customEvents: Array<{ name: string; data: unknown }> = [];
    const callbackContentBlockTypes: string[] = [];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const stream = await model.stream("Run tests.", {
      callbacks: [
        {
          handleLLMNewToken(_token, _idx, _runId, _parentRunId, _tags, fields) {
            const chunk = fields?.chunk;
            if (hasMessageContentBlocks(chunk)) {
              callbackContentBlockTypes.push(
                ...chunk.message.contentBlocks.map((block) => block.type),
              );
            }
          },
          handleCustomEvent(name, data) {
            customEvents.push({ name, data });
          },
        },
      ],
    });
    const contentBlocks = [];
    let text = "";

    for await (const chunk of stream) {
      text += chunk.text;
      contentBlocks.push(...chunk.contentBlocks);
    }

    expect(text).toBe("Done");
    expect(contentBlocks).toMatchObject([
      { id: "reason-1", type: "reasoning", reasoning: "Need tests." },
      {
        id: "cmd-1",
        type: "server_tool_call",
        name: "codex_shell",
        args: { command: "npm test" },
      },
      {
        type: "server_tool_call_result",
        toolCallId: "cmd-1",
        status: "success",
        output: {
          command: "npm test",
          output: "4 passed",
          exitCode: 0,
        },
      },
      { type: "text", text: "Done" },
    ]);
    expect(customEvents.map((event) => event.name)).toEqual([
      "codex.thread.started",
      "codex.turn.started",
      "codex.reasoning.updated",
      "codex.command_execution.started",
      "codex.command_execution.completed",
      "codex.agent_message.updated",
      "codex.turn.completed",
    ]);
    expect(callbackContentBlockTypes).toContain("reasoning");
    expect(callbackContentBlockTypes).toContain("server_tool_call");
    expect(callbackContentBlockTypes).toContain("server_tool_call_result");

    const streamEvents = model.streamEvents("Run tests.", { version: "v2" });
    const customStreamEventNames: string[] = [];

    for await (const event of streamEvents) {
      if (event.event === "on_custom_event") {
        customStreamEventNames.push(event.name);
      }
    }

    expect(customStreamEventNames).toEqual([
      "codex.thread.started",
      "codex.turn.started",
      "codex.reasoning.updated",
      "codex.command_execution.started",
      "codex.command_execution.completed",
      "codex.agent_message.updated",
      "codex.turn.completed",
    ]);
  });

  it("implements withStructuredOutput using Codex outputSchema", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = '{"summary":"ok","riskLevel":"low"}';
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const structured = model.withStructuredOutput(
      z.object({
        summary: z.string(),
        riskLevel: z.enum(["low", "medium", "high"]),
      }),
    );

    const response = await structured.invoke("Summarize.");

    expect(response).toEqual({ summary: "ok", riskLevel: "low" });
    expect(client.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        summary: { type: "string" },
        riskLevel: { enum: ["low", "medium", "high"] },
      },
    });
  });

  it("rejects LangChain tool calling", () => {
    const model = new ChatCodexSDK({ codexClient: asCodexClient(new FakeCodexClient()) });

    expect(() => model.bindTools([])).toThrow(CodexUnsupportedFeatureError);
  });
});

async function* toAsyncGenerator(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

function asCodexClient(client: FakeCodexClient): CodexClientLike {
  return client;
}

function hasMessageContentBlocks(
  value: unknown,
): value is { message: { contentBlocks: Array<{ type: string }> } } {
  return (
    isRecord(value) &&
    isRecord(value.message) &&
    Array.isArray(value.message.contentBlocks) &&
    value.message.contentBlocks.every((block) => isRecord(block) && typeof block.type === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
