import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
});

const response = await model.invoke("Review this repo and summarize the risks.");
console.log(response.content);
