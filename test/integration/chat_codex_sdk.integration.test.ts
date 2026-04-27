import { describe, expect, it } from "vitest";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { ChatCodexSDK } from "../../src/index.js";

const runIntegrationTests = process.env.RUN_CODEX_INTEGRATION_TESTS === "1";
const integrationModel = process.env.CODEX_INTEGRATION_MODEL ?? "gpt-5.4";
const integrationTimeoutMs = Number(process.env.CODEX_INTEGRATION_TIMEOUT_MS ?? 180_000);

const repoInspectionPrompt = [
  "Use a shell command to inspect package.json in this repository.",
  'Then reply with one short sentence that includes the package name "langchain-codex".',
].join(" ");

describe.skipIf(!runIntegrationTests)("ChatCodexSDK integration", () => {
  it(
    "invokes local Codex and exposes real thread items as content blocks",
    async () => {
      const model = createIntegrationModel();

      const response = await model.invoke(repoInspectionPrompt);

      expect(typeof response.text).toBe("string");
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.text.toLowerCase()).toContain("langchain-codex");

      const codex = getCodexMetadata(response.response_metadata);

      expect(codex.threadId).toEqual(expect.any(String));
      expect(response.contentBlocks.some((block) => block.type === "text")).toBe(true);

      const items = codex.items;
      expect(items).toEqual(expect.any(Array));
      expect(items.some((item) => isCodexItemType(item, "agent_message"))).toBe(true);

      assertContentBlocksForObservedRuntimeItems(response.contentBlocks, items);
    },
    integrationTimeoutMs,
  );

  it(
    "keeps content blocks when raw Codex items are suppressed",
    async () => {
      const model = createIntegrationModel();

      const response = await model.invoke(repoInspectionPrompt, { includeCodexItems: false });
      const codex = getCodexMetadata(response.response_metadata);

      expect(typeof response.text).toBe("string");
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.text.toLowerCase()).toContain("langchain-codex");
      expect(codex.threadId).toEqual(expect.any(String));
      expect(codex.hasItems).toBe(false);
      expect(response.contentBlocks.some((block) => block.type === "text")).toBe(true);
    },
    integrationTimeoutMs,
  );

  it(
    "returns LangChain tool calls through experimental bindTools",
    async () => {
      const model = createIntegrationModel();
      const forcedToolModel = model.bindTools([multiplyTool], { tool_choice: "multiply" });

      const first = await forcedToolModel.invoke(
        "Call the multiply tool with a = 6 and b = 7. Do not answer directly.",
      );
      const toolCall = first.tool_calls?.[0];

      expect(toolCall).toBeDefined();
      expect(toolCall?.name).toBe("multiply");
      expect(toolCall?.args.a).toBe(6);
      expect(toolCall?.args.b).toBe(7);
      expect(toolCall?.id).toEqual(expect.any(String));

      expect(toolsCondition([new HumanMessage("Call multiply."), first])).toBe("tools");

      const toolResult = asToolNodeResult(
        await new ToolNode([multiplyTool]).invoke({
          messages: [new HumanMessage("Call multiply."), first],
        }),
      );
      const toolMessage = toolResult.messages[0];

      expect(toolMessage?.content).toBe("42");
      expect(toolMessage?.tool_call_id).toBe(toolCall?.id);
      const toolMessageContent =
        typeof toolMessage?.content === "string" ? toolMessage.content : "42";

      const finalModel = model.bindTools([multiplyTool], { tool_choice: "none" });
      const final = await finalModel.invoke([
        new HumanMessage("Call the multiply tool with a = 6 and b = 7."),
        first,
        new ToolMessage({
          content: toolMessageContent,
          tool_call_id: toolMessage?.tool_call_id ?? toolCall?.id ?? "missing-tool-call-id",
          name: "multiply",
        }),
      ]);

      expect(final.tool_calls ?? []).toHaveLength(0);
      expect(final.text).toContain("42");
    },
    integrationTimeoutMs,
  );

  it(
    "streams local Codex chunks and emits real codex custom events",
    async () => {
      const model = createIntegrationModel();

      const stream = await model.stream(repoInspectionPrompt);
      const streamedBlocks: Array<{ type: string }> = [];
      let streamedText = "";

      for await (const chunk of stream) {
        streamedText += chunk.text;
        streamedBlocks.push(...chunk.contentBlocks);
      }

      expect(streamedText.length).toBeGreaterThan(0);
      expect(streamedText.toLowerCase()).toContain("langchain-codex");
      expect(streamedBlocks.some((block) => block.type === "text")).toBe(true);

      const eventStream = model.streamEvents(repoInspectionPrompt, { version: "v2" });
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
      expect(customEventNames.some((name) => name.startsWith("codex.command_execution."))).toBe(
        true,
      );
    },
    integrationTimeoutMs,
  );
});

describe.skip("ChatCodexSDK prompt-mediated tool-calling reliability eval", () => {
  it.each([
    "irrelevant text around JSON",
    "prompt injection asking to bypass tool schema",
    "multiple available tools with one correct forced choice",
    "nested object and array parameter schemas",
    "optional fields omitted and present",
    "large integer and floating-point arguments",
    "follow-up ToolMessage turn requiring a final answer",
  ])("handles adversarial case: %s", async () => {
    const model = createIntegrationModel();
    const modelWithTools = model.bindTools([multiplyTool], {
      tool_choice: "auto",
      toolCallValidation: "strict",
      toolCallRepairRetries: 1,
    });

    await modelWithTools.invoke("Manual reliability eval placeholder.");
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

function createIntegrationModel(): ChatCodexSDK {
  return new ChatCodexSDK({
    model: integrationModel,
    workingDirectory: process.cwd(),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    timeoutMs: integrationTimeoutMs,
  });
}

function getCodexMetadata(responseMetadata: unknown): {
  threadId?: unknown;
  hasItems: boolean;
  items: unknown[];
} {
  if (!isRecord(responseMetadata) || !isRecord(responseMetadata.codex)) {
    return { hasItems: false, items: [] };
  }

  return {
    threadId: responseMetadata.codex.threadId,
    hasItems: "items" in responseMetadata.codex,
    items: Array.isArray(responseMetadata.codex.items) ? responseMetadata.codex.items : [],
  };
}

function assertContentBlocksForObservedRuntimeItems(
  contentBlocks: Array<{ type: string }>,
  items: unknown[],
): void {
  if (items.some((item) => isCodexItemType(item, "reasoning"))) {
    expect(contentBlocks.some((block) => block.type === "reasoning")).toBe(true);
  }

  if (items.some((item) => isCodexItemType(item, "command_execution"))) {
    expect(contentBlocks.some((block) => block.type === "server_tool_call")).toBe(true);
    expect(contentBlocks.some((block) => block.type === "server_tool_call_result")).toBe(true);
  }

  if (items.some((item) => isCodexItemType(item, "mcp_tool_call"))) {
    expect(contentBlocks.some((block) => block.type === "server_tool_call")).toBe(true);
    expect(contentBlocks.some((block) => block.type === "server_tool_call_result")).toBe(true);
  }

  if (
    items.some(
      (item) =>
        isCodexItemType(item, "file_change") ||
        isCodexItemType(item, "todo_list") ||
        isCodexItemType(item, "error"),
    )
  ) {
    expect(contentBlocks.some((block) => block.type === "non_standard")).toBe(true);
  }
}

function isCodexItemType(item: unknown, type: string): boolean {
  return typeof item === "object" && item !== null && "type" in item && item.type === type;
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
