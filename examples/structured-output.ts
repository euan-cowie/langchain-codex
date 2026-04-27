import { z } from "zod";
import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
  timeoutMs: 120_000,
});

const structured = model.withStructuredOutput(
  z.object({
    summary: z.string(),
    riskLevel: z.enum(["low", "medium", "high"]),
  }),
);

const response = await structured.invoke(
  'Run exactly `rg \'"name"|"description"\' package.json`, then summarize the package named "langchain-codex".',
);
console.log(response);
