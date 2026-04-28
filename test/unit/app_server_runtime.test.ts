import { describe, expect, it } from "vitest";
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
  readonly approvalResponses: SentMessage[] = [];
  private readonly queue = new MessageQueue<SentMessage>();
  readonly messages: AsyncIterable<SentMessage> = this.queue;

  constructor(
    private readonly options: {
      approvalRequest?: SentMessage & { id: number | string; method: string };
    } = {},
  ) {}

  send(message: unknown): void {
    const sent = message as SentMessage;
    this.sent.push(sent);

    if (
      this.options.approvalRequest !== undefined &&
      sent.id === this.options.approvalRequest.id &&
      sent.method === undefined
    ) {
      this.approvalResponses.push(sent);
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
        if (this.options.approvalRequest !== undefined) {
          this.queue.push(this.options.approvalRequest);
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
    this.queue.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        itemId: "msg-1",
        delta: "Hello",
      },
    });
    this.queue.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-app",
        turnId: "turn-app",
        itemId: "msg-1",
        delta: " world",
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
          text: "Hello world",
        },
      },
    });
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
