import { readFile } from "node:fs/promises";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { ChatCodexSDK } from "../src/index.js";

type PackageJson = {
  scripts?: Record<string, string>;
};

const listPackageScripts = tool(
  async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
    return JSON.stringify(packageJson.scripts ?? {});
  },
  {
    name: "list_package_scripts",
    description: "List npm scripts from this repository's package.json.",
    schema: z.object({}),
  },
);

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
  timeoutMs: 120_000,
});

const agent = createReactAgent({
  llm: model,
  tools: [listPackageScripts],
  prompt:
    "You are a concise repository assistant. Use client-side LangChain tools only when they are useful.",
});

const result = await agent.invoke({
  messages: [new HumanMessage("Use list_package_scripts, then recommend the best validation script.")],
});

console.log(result.messages.at(-1)?.text);
