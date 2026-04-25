import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
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
      items: [{ id: "msg-1", type: "agent_message" as const, text: this.finalResponse }],
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
      text += typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content);
      finalThreadId = (chunk.response_metadata.codex as { threadId?: string } | undefined)
        ?.threadId;
    }

    expect(text).toBe("Hello world");
    expect(finalThreadId).toBe("thread-stream");
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
