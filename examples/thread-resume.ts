import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
});

const first = await model.invoke("Inspect this repo.");
const threadId = (first.response_metadata.codex as { threadId?: string } | undefined)?.threadId;

const second = await model.invoke(
  "Continue with a concise risk summary.",
  threadId === undefined ? undefined : { threadId },
);

console.log(second.content);
