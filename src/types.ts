import type {
  ApprovalMode,
  CodexOptions,
  Input,
  ModelReasoningEffort,
  SandboxMode,
  Thread,
  ThreadOptions,
  Usage,
  WebSearchMode,
} from "@openai/codex-sdk";
import type {
  BaseChatModelCallOptions,
  BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { CodexToolCallingConfig } from "./tool_calling.js";
import type { ToolCallValidationMode } from "./tool_calling.js";

export type CodexUsage = Usage;

export type ChatCodexSDKRuntime = "sdk" | "app-server";

export type CodexAppServerApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type CodexAppServerDefaultApprovalDecision = "decline" | "cancel" | "throw";

export type CodexAppServerApprovalRequest = {
  kind: "command" | "file_change";
  method: string;
  params: unknown;
};

export type CodexAppServerApprovalHandler = (
  request: CodexAppServerApprovalRequest,
) => Promise<CodexAppServerApprovalDecision> | CodexAppServerApprovalDecision;

export type ChatCodexSDKResponseMetadata = Record<string, unknown> & {
  codex: {
    threadId?: string | null;
    model?: string;
    usage?: CodexUsage;
    items?: unknown[];
    toolCalling?: Record<string, unknown>;
  };
};

export type ChatCodexSDKFields = BaseChatModelParams & {
  runtime?: ChatCodexSDKRuntime;
  model?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;

  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: WebSearchMode;
  webSearchEnabled?: boolean;
  additionalDirectories?: string[];

  threadId?: string;
  env?: Record<string, string>;
  baseUrl?: string;
  apiKey?: string;
  codexPathOverride?: string;
  codexConfig?: CodexOptions["config"];
  appServerApprovalHandler?: CodexAppServerApprovalHandler;
  appServerDefaultApprovalDecision?: CodexAppServerDefaultApprovalDecision;

  timeoutMs?: number;
  toolCallValidation?: ToolCallValidationMode;
  toolCallRepairRetries?: number;

  /** @internal Used by unit tests and controlled hosts. */
  codexClient?: CodexClientLike;
};

export type ChatCodexSDKCallOptions = BaseChatModelCallOptions & {
  outputSchema?: unknown;
  threadId?: string;
  timeoutMs?: number;
  includeCodexItems?: boolean;
  toolCallValidation?: ToolCallValidationMode;
  toolCallRepairRetries?: number;

  /** @internal Experimental prompt-mediated LangChain tool-calling mode. */
  codexToolCalling?: CodexToolCallingConfig;
};

export type CodexThreadLike = Pick<Thread, "id" | "run" | "runStreamed">;

export type CodexClientLike = {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
};

export type CodexInput = Input;

export type CodexThreadOptions = ThreadOptions;
