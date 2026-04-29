import { describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatCodexSDK } from "../../src/index.js";

const runAppServerIntegrationTests = process.env.CODEX_APP_SERVER_INTEGRATION === "1";
const appServerIntegrationModel =
  process.env.CODEX_APP_SERVER_INTEGRATION_MODEL ??
  process.env.CODEX_INTEGRATION_MODEL ??
  "gpt-5.4";
const appServerIntegrationTimeoutMs = Number(
  process.env.CODEX_APP_SERVER_INTEGRATION_TIMEOUT_MS ??
    process.env.CODEX_INTEGRATION_TIMEOUT_MS ??
    180_000,
);
const appServerCloseTimeoutMs = Number(
  process.env.CODEX_APP_SERVER_INTEGRATION_CLOSE_TIMEOUT_MS ?? 30_000,
);

describe.skipIf(!runAppServerIntegrationTests)("ChatCodexSDK App Server integration", () => {
  it(
    "invokes through a real codex app-server process",
    async () => {
      const model = createAppServerIntegrationModel();

      try {
        const response = await model.invoke(
          "Reply with exactly this lowercase token and no punctuation: app-server-invoke-ok",
        );

        expect(response.text.toLowerCase()).toContain("app-server-invoke-ok");
        expect(response.contentBlocks.some((block) => block.type === "text")).toBe(true);

        const codex = getCodexMetadata(response.response_metadata);
        expect(codex.threadId).toEqual(expect.any(String));
        expect(codex.items.some((item) => isCodexItemType(item, "agent_message"))).toBe(true);
      } finally {
        await model.close();
      }
    },
    appServerIntegrationTimeoutMs,
  );

  it(
    "streams chunks and custom events through App Server",
    async () => {
      const model = createAppServerIntegrationModel();

      try {
        const stream = await model.stream(
          "Reply with exactly this lowercase token and no punctuation: app-server-stream-ok",
        );
        let streamedText = "";
        let streamedThreadId: unknown;

        for await (const chunk of stream) {
          streamedText += chunk.text;
          streamedThreadId = (chunk.response_metadata.codex as { threadId?: string } | undefined)
            ?.threadId;
        }

        expect(streamedText.toLowerCase()).toContain("app-server-stream-ok");
        expect(streamedThreadId).toEqual(expect.any(String));

        const eventStream = model.streamEvents(
          "Reply with exactly this lowercase token and no punctuation: app-server-events-ok",
          { version: "v2" },
        );
        const customEventNames: string[] = [];

        for await (const event of eventStream) {
          if (event.event === "on_custom_event") {
            customEventNames.push(event.name);
          }
        }

        expect(customEventNames).toContain("codex.thread.started");
        expect(customEventNames).toContain("codex.turn.started");
        expect(customEventNames).toContain("codex.turn.completed");
        expect(customEventNames.some((name) => name.startsWith("codex.agent_message."))).toBe(true);
      } finally {
        await model.close();
      }
    },
    appServerIntegrationTimeoutMs,
  );

  it(
    "resumes an explicit Codex thread through App Server",
    async () => {
      const model = createAppServerIntegrationModel();

      try {
        const first = await model.invoke(
          "Reply with exactly this lowercase token and no punctuation: app-server-resume-one",
        );
        const threadId = getCodexMetadata(first.response_metadata).threadId;

        expect(threadId).toEqual(expect.any(String));

        const second = await model.invoke(
          "Reply with exactly this lowercase token and no punctuation: app-server-resume-two",
          typeof threadId === "string" ? { threadId } : undefined,
        );

        expect(second.text.toLowerCase()).toContain("app-server-resume-two");
        expect(getCodexMetadata(second.response_metadata).threadId).toBe(threadId);
      } finally {
        await model.close();
      }
    },
    appServerIntegrationTimeoutMs,
  );

  it(
    "uses App Server outputSchema for withStructuredOutput",
    async () => {
      const model = createAppServerIntegrationModel();
      const structured = model.withStructuredOutput(
        z.object({
          runtime: z.literal("app-server"),
          ok: z.boolean(),
        }),
      );

      try {
        const parsed = await structured.invoke(
          'Return JSON with runtime set to "app-server" and ok set to true.',
        );

        expect(parsed).toEqual({
          runtime: "app-server",
          ok: true,
        });
      } finally {
        await model.close();
      }
    },
    appServerIntegrationTimeoutMs,
  );

  it(
    "returns LangChain tool calls through prompt-mediated bindTools",
    async () => {
      const model = createAppServerIntegrationModel();
      const modelWithTools = model.bindTools([multiplyTool], { tool_choice: "multiply" });

      try {
        const response = await modelWithTools.invoke(
          "Call the multiply tool with a = 6 and b = 7. Do not answer directly.",
        );
        const toolCall = response.tool_calls?.[0];

        expect(toolCall).toBeDefined();
        expect(toolCall?.name).toBe("multiply");
        expect(toolCall?.args).toMatchObject({ a: 6, b: 7 });
        expect(toolCall?.id).toEqual(expect.any(String));
      } finally {
        await model.close();
      }
    },
    appServerIntegrationTimeoutMs,
  );

  it(
    "closes the real App Server child after early stream cancellation",
    async () => {
      const model = createAppServerIntegrationModel();
      const events = model.streamEvents(
        "Start a long answer with app-server-cancel-ok, then write 100 short numbered lines.",
        { version: "v2" },
      );
      const iterator = events[Symbol.asyncIterator]();
      let closed = false;

      try {
        await waitForCustomEvent(iterator, "codex.turn.started", appServerIntegrationTimeoutMs);
        await withTimeout(
          cancelIterator(iterator),
          appServerCloseTimeoutMs,
          "Codex App Server stream did not cancel cleanly.",
        );
        await withTimeout(
          model.close(),
          appServerCloseTimeoutMs,
          "Codex App Server child did not exit after close().",
        );
        closed = true;
      } finally {
        if (!closed) {
          await withTimeout(
            model.close(),
            appServerCloseTimeoutMs,
            "Codex App Server child did not exit during cleanup.",
          );
        }
      }
    },
    appServerIntegrationTimeoutMs,
  );
});

const multiplyTool = tool(({ a, b }: { a: number; b: number }) => a * b, {
  name: "multiply",
  description: "Multiply two numbers.",
  schema: z.object({
    a: z.number(),
    b: z.number(),
  }),
});

function createAppServerIntegrationModel(): ChatCodexSDK {
  return new ChatCodexSDK({
    runtime: "app-server",
    model: appServerIntegrationModel,
    workingDirectory: process.cwd(),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    timeoutMs: appServerIntegrationTimeoutMs,
  });
}

function getCodexMetadata(responseMetadata: unknown): {
  threadId?: unknown;
  items: unknown[];
} {
  if (!isRecord(responseMetadata) || !isRecord(responseMetadata.codex)) {
    return { items: [] };
  }

  return {
    threadId: responseMetadata.codex.threadId,
    items: Array.isArray(responseMetadata.codex.items) ? responseMetadata.codex.items : [],
  };
}

function isCodexItemType(item: unknown, type: string): boolean {
  return typeof item === "object" && item !== null && "type" in item && item.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitForCustomEvent(
  iterator: AsyncIterator<unknown>,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  while (true) {
    const next = await withTimeout(
      iterator.next(),
      timeoutMs,
      `Timed out waiting for ${eventName}.`,
    );

    if (next.done === true) {
      throw new Error(`Stream ended before ${eventName}.`);
    }

    if (isCustomEvent(next.value, eventName)) {
      return;
    }
  }
}

function isCustomEvent(value: unknown, eventName: string): boolean {
  return isRecord(value) && value.event === "on_custom_event" && value.name === eventName;
}

async function cancelIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.();
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
