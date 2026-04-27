import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import type { ThreadItem } from "@openai/codex-sdk";
import { AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ChatCodexSDK,
  CodexStructuredOutputError,
  CodexUnsupportedFeatureError,
} from "../../src/index.js";
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
  finalResponses: string[] = [];
  usages: Array<typeof usage | null> = [];
  items: ThreadItem[] | undefined;
  events: ThreadEvent[] = [];

  constructor(id: string | null) {
    this.id = id;
  }

  run(input: CodexInput, options?: TurnOptions) {
    this.id ??= "thread-new";
    this.runInputs.push(input);
    this.runOptions.push(options ?? {});
    const finalResponse = this.finalResponses.shift() ?? this.finalResponse;
    const runUsage = this.usages.shift() ?? usage;

    return Promise.resolve({
      finalResponse,
      usage: runUsage,
      items: this.items ?? [
        { id: `msg-${this.runInputs.length}`, type: "agent_message" as const, text: finalResponse },
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
  it("signals tool support as experimental bindTools compatibility", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "final",
      content: "No client-side tool is needed.",
      tool_calls: [],
    });
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    expect(model.profile).toMatchObject({
      toolCalling: true,
      toolChoice: true,
    });

    const modelWithTools = model.bindTools([multiplyTool], { tool_choice: "none" });
    await modelWithTools.invoke("Answer without calling a tool.");

    expect(client.startedThread.runInputs[0]).toEqual(
      expect.stringContaining("Experimental LangChain tool-calling mode is active."),
    );
    expect(client.startedThread.runInputs[0]).toEqual(
      expect.stringContaining("The tools below are client-side LangChain tools."),
    );
    expect(client.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      properties: {
        tool_calls: {
          description:
            "Client-side LangChain tool calls to execute. Use this only when type is tool_calls.",
        },
      },
    });
  });

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

  it("surfaces Codex reasoning effort through LangChain params and thread options", async () => {
    const client = new FakeCodexClient();
    const model = new ChatCodexSDK({
      model: "gpt-5.4",
      modelReasoningEffort: "low",
      codexClient: asCodexClient(client),
    });

    await model.invoke("Review this repo.");

    expect(client.startThreadOptions[0]).toMatchObject({
      modelReasoningEffort: "low",
    });
    expect(model.invocationParams()).toMatchObject({
      modelReasoningEffort: "low",
    });
    expect(model._identifyingParams()).toMatchObject({
      modelReasoningEffort: "low",
    });
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

  it("deduplicates streamed Codex metadata items using latest item state", async () => {
    const client = new FakeCodexClient();
    client.startedThread.events = [
      { type: "thread.started", thread_id: "thread-stream" },
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
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Done" },
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
        item: { id: "msg-1", type: "agent_message", text: "Done." },
      },
      { type: "turn.completed", usage },
    ];
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });

    const stream = await model.stream("Run tests.");
    let finalItems: ThreadItem[] | undefined;

    for await (const chunk of stream) {
      const codex = chunk.response_metadata.codex as { items?: ThreadItem[] } | undefined;
      finalItems = codex?.items ?? finalItems;
    }

    expect(finalItems).toEqual([
      expect.objectContaining({
        id: "cmd-1",
        type: "command_execution",
        aggregated_output: "4 passed",
        status: "completed",
      }),
      expect.objectContaining({
        id: "msg-1",
        type: "agent_message",
        text: "Done.",
      }),
    ]);
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

  it("returns includeRaw structured output results with the original message", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = '{"summary":"ok","riskLevel":"low"}';
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const structured = model.withStructuredOutput(
      z.object({
        summary: z.string(),
        riskLevel: z.enum(["low", "medium", "high"]),
      }),
      { includeRaw: true },
    );

    const response = await structured.invoke("Summarize.");

    expect(response.parsed).toEqual({ summary: "ok", riskLevel: "low" });
    expect(response.raw.text).toBe('{"summary":"ok","riskLevel":"low"}');
    expect(response.raw.response_metadata.codex).toMatchObject({
      threadId: "thread-new",
      usage,
    });
  });

  it("throws structured output errors for malformed JSON", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = "not json";
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const structured = model.withStructuredOutput(
      z.object({
        summary: z.string(),
      }),
    );

    await expect(structured.invoke("Summarize.")).rejects.toThrow(CodexStructuredOutputError);
  });

  it("throws structured output errors for Zod validation failures", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = '{"summary":"ok","riskLevel":"urgent"}';
    const model = new ChatCodexSDK({ codexClient: asCodexClient(client) });
    const structured = model.withStructuredOutput(
      z.object({
        summary: z.string(),
        riskLevel: z.enum(["low", "medium", "high"]),
      }),
    );

    await expect(structured.invoke("Summarize.")).rejects.toThrow(CodexStructuredOutputError);
  });

  it("rejects unsupported withStructuredOutput modes", () => {
    const model = new ChatCodexSDK({ codexClient: asCodexClient(new FakeCodexClient()) });
    const schema = z.object({ summary: z.string() });

    expect(() => model.withStructuredOutput(schema, { strict: true })).toThrow(
      CodexUnsupportedFeatureError,
    );
    expect(() => model.withStructuredOutput(schema, { method: "functionCalling" })).toThrow(
      CodexUnsupportedFeatureError,
    );
    expect(() => model.withStructuredOutput(schema, { method: "jsonMode" })).toThrow(
      CodexUnsupportedFeatureError,
    );
    expect(() => model.withStructuredOutput(schema, { method: "custom" })).toThrow(
      CodexUnsupportedFeatureError,
    );
  });

  it("returns LangChain tool calls from experimental bindTools", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ name: "multiply", args: { a: 6, b: 7 } }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("What is 6 * 7?");

    expect(response.content).toBe("");
    expect(response.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "call_1_multiply",
        name: "multiply",
        args: { a: 6, b: 7 },
      },
    ]);
    const outputSchema = expectRecord(client.startedThread.runOptions[0]?.outputSchema);
    const schemaProperties = expectRecord(outputSchema.properties);
    const toolCallsSchema = expectRecord(schemaProperties.tool_calls);
    const toolCallItemsSchema = expectRecord(toolCallsSchema.items);
    const toolCallProperties = expectRecord(toolCallItemsSchema.properties);
    const nameSchema = expectRecord(toolCallProperties.name);
    const argsSchema = expectRecord(toolCallProperties.args);
    const argsProperties = expectRecord(argsSchema.properties);
    const aSchema = expectRecord(argsProperties.a);
    const bSchema = expectRecord(argsProperties.b);

    expect(outputSchema.type).toBe("object");
    expect(toolCallsSchema.type).toBe("array");
    expect(nameSchema.enum).toEqual(["multiply"]);
    expect(argsSchema.type).toBe("object");
    expect(aSchema.type).toBe("number");
    expect(bSchema.type).toBe("number");
    expect(client.startedThread.runInputs[0]).toEqual(expect.stringContaining("multiply"));
    expect(client.startedThread.runInputs[0]).toEqual(
      expect.stringContaining("Experimental LangChain tool-calling mode"),
    );
  });

  it("supports forced tool_choice in experimental bindTools", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ name: "multiply", args: { a: 3, b: 5 } }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools(
      [multiplyTool],
      { tool_choice: "multiply" },
    );

    const response = await modelWithTools.invoke("Use the tool.");

    expect(response.tool_calls?.[0]).toMatchObject({
      name: "multiply",
      args: { a: 3, b: 5 },
    });
    expect(client.startedThread.runInputs[0]).toEqual(
      expect.stringContaining("Tool choice: you must call the multiply tool."),
    );
  });

  it("restricts strict output schemas for none, any, and forced tool_choice", async () => {
    const noneClient = new FakeCodexClient();
    noneClient.startedThread.finalResponse = JSON.stringify({
      type: "final",
      content: "No tool.",
      tool_calls: [],
    });
    await new ChatCodexSDK({ codexClient: asCodexClient(noneClient) })
      .bindTools([multiplyTool], { tool_choice: "none" })
      .invoke("Answer directly.");

    expect(noneClient.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      properties: {
        type: { enum: ["final"] },
        tool_calls: { maxItems: 0 },
      },
    });

    const anyClient = new FakeCodexClient();
    anyClient.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "multiply", args: { a: 2, b: 4 } }],
    });
    await new ChatCodexSDK({ codexClient: asCodexClient(anyClient) })
      .bindTools([multiplyTool], { tool_choice: "any" })
      .invoke("Use a tool.");

    expect(anyClient.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      properties: {
        type: { enum: ["tool_calls"] },
        tool_calls: { minItems: 1 },
      },
    });

    const forcedClient = new FakeCodexClient();
    forcedClient.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "multiply", args: { a: 2, b: 4 } }],
    });
    await new ChatCodexSDK({ codexClient: asCodexClient(forcedClient) })
      .bindTools([multiplyTool, addTool], { tool_choice: "multiply" })
      .invoke("Use multiply.");

    expect(forcedClient.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      properties: {
        type: { enum: ["tool_calls"] },
        tool_calls: {
          items: {
            properties: {
              name: { enum: ["multiply"] },
            },
          },
        },
      },
    });
  });

  it("preserves local JSON Schema refs when embedding strict tool arg schemas", async () => {
    const client = new FakeCodexClient();
    const args = { root: { label: "parent", child: { label: "child" } } };
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "tree", args }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      treeTool,
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("Use the tree tool.");

    expect(response.tool_calls?.[0]).toMatchObject({
      name: "tree",
      args,
    });

    const outputSchema = expectRecord(client.startedThread.runOptions[0]?.outputSchema);
    const validate = new Ajv({ allErrors: true, schemaId: "auto" }).compile(outputSchema);
    const schemaAcceptedResponse = validate({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "tree", args }],
    });

    expect(schemaAcceptedResponse).toBe(true);
    expect(validate.errors).toBeNull();

    const schemaProperties = expectRecord(outputSchema.properties);
    const toolCallsSchema = expectRecord(schemaProperties.tool_calls);
    const toolCallItemsSchema = expectRecord(toolCallsSchema.items);
    const variants = toolCallItemsSchema.oneOf;
    if (!Array.isArray(variants)) {
      throw new Error("Expected strict multi-tool schema to use oneOf.");
    }

    const treeToolSchema = expectRecord(variants[0]);
    const treeToolProperties = expectRecord(treeToolSchema.properties);
    const treeArgsSchema = expectRecord(treeToolProperties.args);
    const treeArgsProperties = expectRecord(treeArgsSchema.properties);
    const rootSchema = expectRecord(treeArgsProperties.root);
    const treeDefs = expectRecord(treeArgsSchema.$defs);
    const treeNodeSchema = expectRecord(treeDefs.treeNode);
    const treeNodeProperties = expectRecord(treeNodeSchema.properties);
    const childSchema = expectRecord(treeNodeProperties.child);
    const nestedArgsPointer = "#/properties/tool_calls/items/oneOf/0/properties/args";

    expect(rootSchema.$ref).toBe(`${nestedArgsPointer}/$defs/treeNode`);
    expect(childSchema.$ref).toBe(`${nestedArgsPointer}/$defs/treeNode`);
  });

  it("repairs malformed bound-tool JSON once by default", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      "not json",
      JSON.stringify({
        type: "final",
        content: "Recovered.",
        tool_calls: [],
      }),
    ];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("Say hello.");

    expect(response.text).toBe("Recovered.");
    expect(client.startedThread.runInputs).toHaveLength(2);
    expect(client.startedThread.runInputs[1]).toEqual(
      expect.stringContaining("Your previous response did not satisfy"),
    );
    expect(client.startedThread.runOptions[1]?.outputSchema).toBe(
      client.startedThread.runOptions[0]?.outputSchema,
    );
  });

  it("repairs unknown tools and aggregates usage and trace metadata", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-1", name: "unknown", args: {} }],
      }),
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-2", name: "multiply", args: { a: 6, b: 7 } }],
      }),
    ];
    client.startedThread.usages = [
      {
        input_tokens: 3,
        cached_input_tokens: 1,
        output_tokens: 4,
        reasoning_output_tokens: 2,
      },
      {
        input_tokens: 5,
        cached_input_tokens: 2,
        output_tokens: 6,
        reasoning_output_tokens: 1,
      },
    ];
    const customEvents: Array<{ name: string; data: unknown }> = [];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("What is 6 * 7?", {
      callbacks: [
        {
          handleCustomEvent(name, data) {
            customEvents.push({ name, data });
          },
        },
      ],
    });

    expect(response.tool_calls?.[0]).toMatchObject({
      id: "call-2",
      name: "multiply",
      args: { a: 6, b: 7 },
    });
    expect(response.usage_metadata).toEqual({
      input_tokens: 8,
      output_tokens: 10,
      total_tokens: 18,
    });
    const responseCodexMetadata = expectRecord(response.response_metadata.codex);
    expect(responseCodexMetadata.usage).toEqual({
      input_tokens: 8,
      cached_input_tokens: 3,
      output_tokens: 10,
      reasoning_output_tokens: 3,
    });
    const toolCallingTrace = expectRecord(responseCodexMetadata.toolCalling);
    expect(toolCallingTrace.validationMode).toBe("strict");
    expect(toolCallingTrace.toolChoice).toBe("auto");
    expect(toolCallingTrace.attempts).toBe(2);
    expect(toolCallingTrace.repairAttempted).toBe(true);
    expect(toolCallingTrace.repairSucceeded).toBe(true);
    const validationErrorSummaries = toolCallingTrace.validationErrorSummaries;
    if (!Array.isArray(validationErrorSummaries)) {
      throw new Error("Expected validation error summaries to be an array.");
    }
    const validationErrorSummary = expectRecord(validationErrorSummaries[0]);
    expect(validationErrorSummary.attempt).toBe(1);
    if (typeof validationErrorSummary.summary !== "string") {
      throw new Error("Expected validation error summary to be a string.");
    }
    expect(validationErrorSummary.summary).toContain('unknown tool "unknown"');
    expect(customEvents.map((event) => event.name)).toContain("codex.tool_calling.attempt.failed");
    expect(customEvents.map((event) => event.name)).toContain(
      "codex.tool_calling.attempt.succeeded",
    );
    expect(customEvents.map((event) => event.name)).toContain("codex.tool_calling.completed");
    expect(JSON.stringify(toolCallingTrace)).not.toContain('"args"');
  });

  it("repairs Zod arg validation failures without coercing returned args", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-1", name: "multiply", args: { a: "6", b: 7 } }],
      }),
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-2", name: "multiply", args: { a: 6, b: 7 } }],
      }),
    ];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("What is 6 * 7?");

    expect(response.tool_calls?.[0]?.args).toEqual({ a: 6, b: 7 });
    expect(client.startedThread.runInputs).toHaveLength(2);
  });

  it("validates OpenAI-style JSON Schema tool args with Ajv", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-1", name: "lookup", args: { query: 123, limit: 2 } }],
      }),
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-2", name: "lookup", args: { query: "codex", limit: 2 } }],
      }),
    ];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      lookupTool,
    ]);

    const response = await modelWithTools.invoke("Look up codex.");

    expect(response.tool_calls?.[0]).toMatchObject({
      name: "lookup",
      args: { query: "codex", limit: 2 },
    });
    expect(client.startedThread.runInputs).toHaveLength(2);
    const repairPrompt = client.startedThread.runInputs[1];
    if (typeof repairPrompt !== "string") {
      throw new Error("Expected repair prompt to be a string.");
    }
    expect(repairPrompt).toContain("/query");
  });

  it("throws after bound-tool repair retries are exhausted", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-1", name: "multiply", args: { a: "6", b: 7 } }],
      }),
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-2", name: "multiply", args: { a: "6", b: 7 } }],
      }),
    ];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    await expect(modelWithTools.invoke("What is 6 * 7?")).rejects.toThrow(
      CodexStructuredOutputError,
    );
    expect(client.startedThread.runInputs).toHaveLength(2);
  });

  it("supports basic tool-call validation as a compatibility escape hatch", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "multiply", args: JSON.stringify({ a: "6", b: "7" }) }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools(
      [multiplyTool],
      { toolCallValidation: "basic", toolCallRepairRetries: 0 },
    );

    const response = await modelWithTools.invoke("What is 6 * 7?");

    expect(response.tool_calls?.[0]?.args).toEqual({ a: "6", b: "7" });
    expect(client.startedThread.runInputs).toHaveLength(1);
    expect(client.startedThread.runInputs[0]).toEqual(
      expect.stringContaining("Validation mode: basic."),
    );
    expect(client.startedThread.runOptions[0]?.outputSchema).toMatchObject({
      properties: {
        tool_calls: {
          items: {
            properties: {
              args: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("validates tool-call repair retry options", async () => {
    expect(() => new ChatCodexSDK({ toolCallRepairRetries: 4 })).toThrow(
      CodexUnsupportedFeatureError,
    );

    const modelWithTools = new ChatCodexSDK({
      codexClient: asCodexClient(new FakeCodexClient()),
    }).bindTools([multiplyTool]);

    await expect(
      modelWithTools.invoke("Use a tool.", { toolCallRepairRetries: 1.5 }),
    ).rejects.toThrow(CodexUnsupportedFeatureError);
  });

  it("streams bound-tool responses through ChatCodexSDK stream chunks", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponses = [
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-0", name: "multiply", args: { a: "4", b: 5 } }],
      }),
      JSON.stringify({
        type: "tool_calls",
        content: "",
        tool_calls: [{ id: "call-1", name: "multiply", args: { a: 4, b: 5 } }],
      }),
    ];
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const stream = await modelWithTools.stream("What is 4 * 5?");
    const chunks: AIMessageChunk[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBeInstanceOf(AIMessageChunk);
    expect(chunks[0]?.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "multiply",
        args: { a: 4, b: 5 },
      },
    ]);
    expect(client.startedThread.runInputs).toHaveLength(2);
  });

  it("returns final answers from experimental bindTools when no tool is needed", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "final",
      content: "No tool is needed.",
      tool_calls: [],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const response = await modelWithTools.invoke("Say hello.");

    expect(response.text).toBe("No tool is needed.");
    expect(response.tool_calls ?? []).toHaveLength(0);
  });

  it("serializes tool-call history for the follow-up turn", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "multiply", args: { a: 6, b: 7 } }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    const first = await modelWithTools.invoke("What is 6 * 7?");
    client.startedThread.finalResponse = JSON.stringify({
      type: "final",
      content: "6 * 7 is 42.",
      tool_calls: [],
    });

    await modelWithTools.invoke([
      new HumanMessage("What is 6 * 7?"),
      first,
      new ToolMessage({ content: "42", tool_call_id: "call-1", name: "multiply" }),
    ]);

    expect(client.startedThread.runInputs[1]).toEqual(expect.stringContaining("Tool calls:"));
    expect(client.startedThread.runInputs[1]).toEqual(expect.stringContaining("name: multiply"));
    expect(client.startedThread.runInputs[1]).toEqual(
      expect.stringContaining("Tool result (multiply) for call-1:"),
    );
    expect(client.startedThread.runInputs[1]).toEqual(expect.stringContaining("42"));
  });

  it("rejects invalid experimental tool-call responses", async () => {
    const client = new FakeCodexClient();
    client.startedThread.finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ name: "unknown", args: {} }],
    });
    const modelWithTools = new ChatCodexSDK({ codexClient: asCodexClient(client) }).bindTools([
      multiplyTool,
    ]);

    await expect(modelWithTools.invoke("Call a tool.")).rejects.toThrow(CodexStructuredOutputError);
  });

  it("rejects raw provider tool options outside bindTools", async () => {
    const model = new ChatCodexSDK({ codexClient: asCodexClient(new FakeCodexClient()) });

    await expect(model.invoke("Use a tool.", { tools: [] } as never)).rejects.toThrow(
      CodexUnsupportedFeatureError,
    );
  });
});

const multiplyTool = tool(({ a, b }: { a: number; b: number }) => a * b, {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

const addTool = tool(({ a, b }: { a: number; b: number }) => a + b, {
  name: "add",
  description: "Add two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

const lookupTool = {
  type: "function",
  function: {
    name: "lookup",
    description: "Look up a query.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;

const treeTool = {
  type: "function",
  function: {
    name: "tree",
    description: "Accept a recursive tree.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["root"],
      properties: {
        root: { $ref: "#/$defs/treeNode" },
      },
      $defs: {
        treeNode: {
          type: "object",
          additionalProperties: false,
          required: ["label"],
          properties: {
            label: { type: "string" },
            child: { $ref: "#/$defs/treeNode" },
          },
        },
      },
    },
  },
} as const;

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

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected a record.");
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
