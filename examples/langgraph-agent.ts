import { readFile } from "node:fs/promises";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { ChatCodexSDK } from "../src/index.js";

type PackageField = "name" | "version" | "description" | "scripts";
type PackageJson = Partial<Record<PackageField, unknown>>;

const readPackageMetadata = tool(
  async ({ field }: { field: PackageField }) => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
    return JSON.stringify({ [field]: packageJson[field] ?? null });
  },
  {
    name: "read_package_metadata",
    description: "Read one metadata field from this repository's package.json.",
    schema: z.object({
      field: z.enum(["name", "version", "description", "scripts"]),
    }),
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

const modelWithTools = model.bindTools([readPackageMetadata]);
const toolNode = new ToolNode([readPackageMetadata]);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state: typeof MessagesAnnotation.State) => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  })
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent")
  .compile();

const result = await graph.invoke({
  messages: [
    new HumanMessage(
      "Use read_package_metadata to identify this package, then summarize what the adapter is for.",
    ),
  ],
});

console.log(result.messages.at(-1)?.text);
