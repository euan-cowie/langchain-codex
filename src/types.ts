import type {
  ApprovalMode,
  Codex,
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

export type CodexUsage = Usage;

export type ChatCodexSDKResponseMetadata = Record<string, unknown> & {
  codex: {
    threadId?: string | null;
    model?: string;
    usage?: CodexUsage;
    items?: unknown[];
  };
};

export type ChatCodexSDKFields = BaseChatModelParams & {
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

  timeoutMs?: number;

  /** @internal Used by unit tests and controlled hosts. */
  codexClient?: CodexClientLike;
};

export type ChatCodexSDKCallOptions = BaseChatModelCallOptions & {
  outputSchema?: unknown;
  threadId?: string;
  timeoutMs?: number;
  includeCodexItems?: boolean;
};

export type CodexClientLike = Pick<Codex, "startThread" | "resumeThread">;

export type CodexThreadLike = Pick<Thread, "id" | "run" | "runStreamed">;

export type CodexInput = Input;

export type CodexThreadOptions = ThreadOptions;
