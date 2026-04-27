import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
  timeoutMs: 120_000,
});

const repoInspectionPrompt =
  'Run exactly `rg \'"name"\' package.json`, then reply with one short sentence that includes the package name "langchain-codex".';

const stream = await model.stream(repoInspectionPrompt);

for await (const chunk of stream) {
  if (chunk.contentBlocks.length > 0) {
    console.log(JSON.stringify(chunk.contentBlocks, null, 2));
  } else {
    process.stdout.write(
      typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content),
    );
  }
}

const events = model.streamEvents(repoInspectionPrompt, {
  version: "v2",
});

for await (const event of events) {
  if (
    event.event === "on_custom_event" &&
    typeof event.name === "string" &&
    event.name.startsWith("codex.")
  ) {
    console.log(event.name, JSON.stringify(event.data));
  }
}
