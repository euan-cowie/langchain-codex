import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CodexUnsupportedFeatureError, convertMessagesToCodexInput } from "../../src/index.js";

describe("convertMessagesToCodexInput", () => {
  it("converts basic chat messages into a single Codex prompt", () => {
    const input = convertMessagesToCodexInput([
      new SystemMessage("Be concise."),
      new HumanMessage("Review the repository."),
      new AIMessage("I will inspect it."),
      new ToolMessage({ content: "test output", tool_call_id: "call-1" }),
    ]);

    expect(input).toBe(
      [
        "System:",
        "Be concise.",
        "",
        "Human:",
        "Review the repository.",
        "",
        "Assistant:",
        "I will inspect it.",
        "",
        "Tool:",
        "test output",
      ].join("\n"),
    );
  });

  it("keeps local image paths as Codex structured input", () => {
    const input = convertMessagesToCodexInput([
      new HumanMessage({
        content: [
          { type: "text", text: "Describe this screenshot." },
          { type: "image", url: "./fixtures/screenshot.png" },
        ],
      }),
    ]);

    expect(input).toEqual([
      { type: "text", text: "Human:\nDescribe this screenshot." },
      { type: "local_image", path: "./fixtures/screenshot.png" },
    ]);
  });

  it("rejects remote image URLs", () => {
    expect(() =>
      convertMessagesToCodexInput([
        new HumanMessage({
          content: [
            { type: "text", text: "Describe this screenshot." },
            { type: "image_url", image_url: { url: "https://example.com/screenshot.png" } },
          ],
        }),
      ]),
    ).toThrow(CodexUnsupportedFeatureError);
  });
});
