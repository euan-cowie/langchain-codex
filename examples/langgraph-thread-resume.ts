import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
  messagesStateReducer,
} from "@langchain/langgraph";
import { ChatCodexSDK, getCodexThreadId } from "../src/index.js";

const CodexGraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  codexThreadId: Annotation<string | undefined>(),
});

const model = new ChatCodexSDK({
  model: "gpt-5.4",
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
});

const graph = new StateGraph(CodexGraphState)
  .addNode("codex", async (state: typeof CodexGraphState.State) => {
    const inputMessages =
      state.codexThreadId === undefined ? state.messages : getPendingCodexMessages(state.messages);
    const response = await model.invoke(
      inputMessages,
      state.codexThreadId === undefined ? undefined : { threadId: state.codexThreadId },
    );

    return {
      messages: [response],
      codexThreadId: getCodexThreadId(response) ?? state.codexThreadId,
    };
  })
  .addEdge(START, "codex")
  .addEdge("codex", END)
  .compile({ checkpointer: new MemorySaver() });

const config = {
  configurable: {
    thread_id: "codex-langgraph-thread-resume-example",
  },
};

await graph.invoke(
  {
    messages: [new HumanMessage("Inspect this repository.")],
  },
  config,
);

const result = await graph.invoke(
  {
    messages: [new HumanMessage("Continue with a concise risk summary.")],
  },
  config,
);

console.log(result.messages.at(-1)?.content);
console.log(result.codexThreadId);

function getPendingCodexMessages(messages: BaseMessage[]): BaseMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.getType() === "ai") {
      return messages.slice(index + 1);
    }
  }

  return messages;
}
