import { ChatCodexSDK, getCodexThreadId } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
  timeoutMs: 120_000,
});

const first = await model.invoke(
  'Run exactly `rg \'"name"\' package.json`, then reply with the package name "langchain-codex".',
);
const threadId = getCodexThreadId(first);

const second = await model.invoke(
  "Continue from the same Codex thread with one concise sentence about what this package does.",
  threadId === undefined ? undefined : { threadId },
);

console.log(second.text);
