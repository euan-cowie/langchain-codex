import { ChatCodexSDK } from "../src/index.js";

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
});

const response = await model.invoke("Summarize how this repository is structured.");
console.log(response.content);
