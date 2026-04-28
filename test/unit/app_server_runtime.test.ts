import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatCodexSDK } from "../../src/index.js";
import { AppServerCodexClient, type AppServerTransport } from "../../src/app_server_runtime.js";

describe("AppServerCodexClient", () => {
  it("runs a turn through the app-server JSON-RPC protocol", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient({ transport });
    const thread = client.startThread({
      model: "gpt-5.4",
      workingDirectory: "/repo",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      modelReasoningEffort: "high",
      networkAccessEnabled: true,
      webSearchMode: "live",
    });

    const result = await thread.run("Human:\nHello.", {
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
    await client.close();

    expect(result.finalResponse).toBe("Hello world");
    expect(result.usage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 5,
      reasoning_output_tokens: 1,
    });
    expect(thread.id).toBe("thread-app");
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);

    const initialize = transport.sent.find((message) => message.method === "initialize");
    expect(initialize?.params).toMatchObject({
      capabilities: {
        experimentalApi: true,
      },
    });

    const initialized = transport.sent.find((message) => message.method === "initialized");
    expect(initialized?.params).toBeUndefined();

    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      model: "gpt-5.4",
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: {
        sandbox_workspace_write: { network_access: true },
        web_search: "live",
      },
    });

    const turnStart = transport.sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thread-app",
      input: [{ type: "text", text: "Human:\nHello.", text_elements: [] }],
      model: "gpt-5.4",
      cwd: "/repo",
      approvalPolicy: "never",
      effort: "high",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
  });

  it("streams app-server deltas through ChatCodexSDK chunks", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient({ transport });
    const model = new ChatCodexSDK({
      runtime: "app-server",
      codexClient: client,
    });

    const stream = await model.stream("Say hello.");
    let text = "";
    let threadId: unknown;

    for await (const chunk of stream) {
      text += chunk.text;
      threadId = (chunk.response_metadata.codex as { threadId?: string } | undefined)?.threadId;
    }
    await model.close();

    expect(text).toBe("Hello world");
    expect(threadId).toBe("thread-app");
  });

  it("uses prompt-mediated bindTools through App Server outputSchema", async () => {
    const finalResponse = JSON.stringify({
      type: "tool_calls",
      content: "",
      tool_calls: [{ id: "call-1", name: "multiply", args: { a: 6, b: 7 } }],
    });
    const transport = new FakeAppServerTransport({ finalResponse });
    const client = new AppServerCodexClient({ transport });
    const model = new ChatCodexSDK({
      runtime: "app-server",
      codexClient: client,
    });
    const modelWithTools = model.bindTools([multiplyTool]);

    const response = await modelWithTools.invoke("What is 6 * 7?");
    await model.close();

    expect(response.tool_calls).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "multiply",
        args: { a: 6, b: 7 },
      },
    ]);
    const turnStart = transport.sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      outputSchema: {
        properties: {
          tool_calls: {
            description:
              "Client-side LangChain tool calls to execute. Use this only when type is tool_calls.",
          },
        },
      },
    });
    expect(JSON.stringify(turnStart?.params)).toContain(
      "Experimental LangChain tool-calling mode",
    );
    expect(JSON.stringify(turnStart?.params)).toContain("multiply");
  });

  it("fails active turns when the app-server transport closes mid-turn", async () => {
    const transport = new FakeAppServerTransport({ closeAfterTurnStarted: true });
    const client = new AppServerCodexClient({ transport });

    await expect(client.startThread().run("Wait forever.")).rejects.toThrow(
      "Codex app-server connection closed.",
    );
    await client.close();
  });

  it("normalizes object-encoded file-change kinds", async () => {
    const transport = new FakeAppServerTransport({
      completedItems: [
        {
          id: "patch-1",
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "README.md",
              kind: { type: "update", move_path: null },
              diff: "@@",
            },
          ],
        },
      ],
    });
    const client = new AppServerCodexClient({ transport });

    const result = await client.startThread().run("Edit README.");
    await client.close();

    expect(result.items).toContainEqual({
      id: "patch-1",
      type: "file_change",
      status: "completed",
      changes: [{ path: "README.md", kind: "update" }],
    });
  });

  it("maps declined command approvals to a terminal failed command status", async () => {
    const transport = new FakeAppServerTransport({
      completedItems: [
        {
          id: "cmd-1",
          type: "commandExecution",
          command: "npm test",
          status: "declined",
          aggregatedOutput: "",
          exitCode: null,
        },
      ],
    });
    const client = new AppServerCodexClient({ transport });

    const result = await client.startThread().run("Run tests.");
    await client.close();

    expect(result.items).toContainEqual({
      id: "cmd-1",
      type: "command_execution",
      command: "npm test",
      aggregated_output: "",
      status: "failed",
    });
  });

  it("routes command approval requests through the configured handler", async () => {
    const transport = new FakeAppServerTransport({
      approvalRequest: {
        id: "approval-command-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "cmd-1",
          command: "npm test",
        },
      },
    });
    const approvals: Array<{ kind: string; method: string; params: unknown }> = [];
    const client = new AppServerCodexClient({
      transport,
      approvalHandler: (request) => {
        approvals.push(request);
        return "accept";
      },
    });

    const result = await client.startThread().run("Run tests.");
    await client.close();

    expect(result.finalResponse).toBe("Hello world");
    expect(approvals).toEqual([
      {
        kind: "command",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "cmd-1",
          command: "npm test",
        },
      },
    ]);
    expect(transport.approvalResponses).toEqual([
      {
        id: "approval-command-1",
        result: { decision: "accept" },
      },
    ]);
  });

  it("uses the configured default decision for file-change approval requests", async () => {
    const transport = new FakeAppServerTransport({
      approvalRequest: {
        id: "approval-file-1",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "patch-1",
          changes: [{ path: "README.md", kind: "update" }],
        },
      },
    });
    const client = new AppServerCodexClient({
      transport,
      defaultApprovalDecision: "cancel",
    });

    const result = await client.startThread().run("Edit README.");
    await client.close();

    expect(result.finalResponse).toBe("Hello world");
    expect(transport.approvalResponses).toEqual([
      {
        id: "approval-file-1",
        result: { decision: "cancel" },
      },
    ]);
  });

  it("fails clearly when an approval request has no handler", async () => {
    const transport = new FakeAppServerTransport({
      approvalRequest: {
        id: "approval-command-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "cmd-1",
          command: "npm test",
        },
      },
    });
    const client = new AppServerCodexClient({ transport });

    await expect(client.startThread().run("Run tests.")).rejects.toThrow(
      "no appServerApprovalHandler is configured",
    );
    await client.close();

    expect(transport.approvalResponses).toEqual([
      {
        id: "approval-command-1",
        error: {
          code: -32000,
          message:
            "Codex app-server requested command approval, but no appServerApprovalHandler is configured.",
        },
      },
    ]);
  });

  it("fails clearly when the approval handler throws", async () => {
    const transport = new FakeAppServerTransport({
      approvalRequest: {
        id: "approval-file-1",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "patch-1",
          changes: [{ path: "README.md", kind: "update" }],
        },
      },
    });
    const client = new AppServerCodexClient({
      transport,
      approvalHandler: () => {
        throw new Error("approval UI failed");
      },
    });

    await expect(client.startThread().run("Edit README.")).rejects.toThrow("approval UI failed");
    await client.close();

    expect(transport.approvalResponses).toEqual([
      {
        id: "approval-file-1",
        error: {
          code: -32000,
          message: "approval UI failed",
        },
      },
    ]);
  });

  it("rejects App Server dynamic tool requests instead of treating them as LangChain tools", async () => {
    const transport = new FakeAppServerTransport({
      serverRequest: {
        id: "dynamic-tool-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          itemId: "tool-1",
          tool: "multiply",
          arguments: { a: 6, b: 7 },
        },
      },
    });
    const client = new AppServerCodexClient({ transport });

    await expect(client.startThread().run("Use a dynamic tool.")).rejects.toThrow(
      "App Server dynamic tools are not supported",
    );
    await client.close();

    expect(transport.serverRequestResponses).toEqual([
      {
        id: "dynamic-tool-1",
        error: {
          code: -32601,
          message:
            "Codex App Server dynamic tools are not supported by ChatCodexSDK. Use ChatCodexSDK.bindTools() for LangChain-standard tool calls.",
        },
      },
    ]);
  });
});

type SentMessage = {
  method?: string;
  id?: number | string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

class FakeAppServerTransport implements AppServerTransport {
  readonly sent: SentMessage[] = [];
  readonly serverRequestResponses: SentMessage[] = [];
  private readonly queue = new MessageQueue<SentMessage>();
  readonly messages: AsyncIterable<SentMessage> = this.queue;

  constructor(
    private readonly options: {
      approvalRequest?: SentMessage & { id: number | string; method: string };
      serverRequest?: SentMessage & { id: number | string; method: string };
      finalResponse?: string;
      completedItems?: Array<Record<string, unknown>>;
      closeAfterTurnStarted?: boolean;
    } = {},
  ) {}

  get approvalResponses(): SentMessage[] {
    return this.serverRequestResponses;
  }

  send(message: unknown): void {
    const sent = message as SentMessage;
    this.sent.push(sent);
    const serverRequest = this.options.serverRequest ?? this.options.approvalRequest;

    if (
      serverRequest !== undefined &&
      sent.id === serverRequest.id &&
      sent.method === undefined
    ) {
      this.serverRequestResponses.push(sent);
      if (sent.result !== undefined) {
        this.pushSuccessfulTurnEvents();
      }
      return;
    }

    if (sent.id === undefined || sent.method === undefined) {
      return;
    }

    switch (sent.method) {
      case "initialize":
        this.queue.push({ id: sent.id, result: { userAgent: "fake" } });
        return;
      case "thread/start":
        this.queue.push({
          id: sent.id,
          result: {
            thread: {
              id: "thread-app",
            },
          },
        });
        return;
      case "turn/start":
        this.queue.push({
          id: sent.id,
          result: {
            turn: {
              id: "turn-app",
              status: "inProgress",
              items: [],
              error: null,
            },
          },
        });
        this.queue.push({
          method: "turn/started",
          params: {
            threadId: "thread-app",
            turn: { id: "turn-app" },
          },
        });
        if (this.options.closeAfterTurnStarted === true) {
          this.queue.close();
          return;
        }
        if (serverRequest !== undefined) {
          this.queue.push(serverRequest);
          return;
        }
        this.pushSuccessfulTurnEvents();
        return;
      default:
        this.queue.push({
          id: sent.id,
          error: { message: `Unexpected request: ${sent.method}` },
        });
    }
  }

  close(): void {
    this.queue.close();
  }

  private pushSuccessfulTurnEvents(): void {
    const finalResponse = this.options.finalResponse ?? "Hello world";
    const midpoint = Math.ceil(finalResponse.length / 2);
    this.queue.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        itemId: "msg-1",
        delta: finalResponse.slice(0, midpoint),
      },
    });
    this.queue.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        itemId: "msg-1",
        delta: finalResponse.slice(midpoint),
      },
    });
    this.queue.push({
      method: "item/completed",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        item: {
          id: "msg-1",
          type: "agentMessage",
          text: finalResponse,
        },
      },
    });
    for (const item of this.options.completedItems ?? []) {
      this.queue.push({
        method: "item/completed",
        params: {
          threadId: "thread-app",
          turnId: "turn-app",
          item,
        },
      });
    }
    this.queue.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        tokenUsage: {
          last: {
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 1,
          },
        },
      },
    });
    this.queue.push({
      method: "turn/completed",
      params: {
        threadId: "thread-app",
        turn: {
          id: "turn-app",
          status: "completed",
          items: [],
          error: null,
        },
      },
    });
  }
}

const multiplyTool = tool(({ a, b }: { a: number; b: number }) => a * b, {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

class MessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
