import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CodexStructuredOutputError } from "../../src/index.js";
import { parseMessageJson, toCodexOutputSchema } from "../../src/structured_output.js";

describe("structured output helpers", () => {
  it("converts Zod v4 schemas to JSON Schema", () => {
    const schema = toCodexOutputSchema(
      z.object({
        summary: z.string(),
        status: z.enum(["ok", "action_required"]),
      }),
      "RepoStatus",
    );

    expect(schema).toMatchObject({
      title: "RepoStatus",
      type: "object",
      properties: {
        summary: { type: "string" },
        status: { type: "string", enum: ["ok", "action_required"] },
      },
      required: ["summary", "status"],
      additionalProperties: false,
    });
  });

  it("passes JSON Schema objects through unchanged", () => {
    const schema = toCodexOutputSchema({
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    });
  });

  it("parses plain JSON and fenced JSON", () => {
    expect(parseMessageJson(new AIMessage('{"ok":true}'))).toEqual({ ok: true });
    expect(parseMessageJson(new AIMessage('```json\n{"ok":true}\n```'))).toEqual({ ok: true });
  });

  it("throws a structured output error for malformed JSON", () => {
    expect(() => parseMessageJson(new AIMessage("not json"))).toThrow(CodexStructuredOutputError);
  });
});
