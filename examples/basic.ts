import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
  timeoutMs: 120_000,
});

const response = await model.invoke(
  'Run exactly `rg \'"name"\' package.json`, then reply with one short sentence that includes the package name "langchain-codex".',
);
console.log(response.text);
