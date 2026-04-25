import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
});

const stream = await model.stream("Review this repo and summarize the risks.");

for await (const chunk of stream) {
  process.stdout.write(
    typeof chunk.content === "string" ? chunk.content : JSON.stringify(chunk.content),
  );
}
