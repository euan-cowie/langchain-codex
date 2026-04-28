import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import type {
  CodexOptions,
  Input,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage,
} from "@openai/codex-sdk";
import type {
  CodexAppServerDefaultApprovalDecision,
  CodexAppServerApprovalDecision,
  CodexAppServerApprovalHandler,
  CodexClientLike,
  CodexThreadLike,
} from "./types.js";

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const APP_SERVER_ORIGINATOR = "langchain_codex_app_server";

type JsonRpcId = number | string;

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcServerRequest = JsonRpcNotification & {
  id: JsonRpcId;
};

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

export type AppServerTransport = {
  messages: AsyncIterable<unknown>;
  send(message: unknown): void;
  close(): Promise<void> | void;
};

export type AppServerCodexClientOptions = CodexOptions & {
  transport?: AppServerTransport;
  approvalHandler?: CodexAppServerApprovalHandler;
  defaultApprovalDecision?: CodexAppServerDefaultApprovalDecision;
};

export class AppServerCodexClient implements CodexClientLike {
  private readonly connection: AppServerConnection;

  constructor(options: AppServerCodexClientOptions = {}) {
    const transport = options.transport ?? new StdioAppServerTransport(options);
    this.connection = new AppServerConnection(transport, {
      defaultApprovalDecision: options.defaultApprovalDecision ?? "throw",
      ...(options.approvalHandler === undefined
        ? {}
        : { approvalHandler: options.approvalHandler }),
    });
  }

  startThread(options?: ThreadOptions): CodexThreadLike {
    return new AppServerThread(this.connection, options ?? {}, null);
  }

  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike {
    return new AppServerThread(this.connection, options ?? {}, id);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

class AppServerThread implements CodexThreadLike {
  private initialized = false;

  constructor(
    private readonly connection: AppServerConnection,
    private readonly threadOptions: ThreadOptions,
    private _id: string | null,
  ) {}

  get id(): string | null {
    return this._id;
  }

  runStreamed(input: Input, turnOptions: TurnOptions = {}) {
    return Promise.resolve({ events: this.runStreamedInternal(input, turnOptions) });
  }

  async run(input: Input, turnOptions: TurnOptions = {}) {
    const streamed = await this.runStreamed(input, turnOptions);
    const items: ThreadItem[] = [];
    let finalResponse = "";
    let usage: Usage | null = null;
    let turnFailure: Error | null = null;

    for await (const event of streamed.events) {
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = new Error(event.error.message);
        break;
      } else if (event.type === "error") {
        turnFailure = new Error(event.message);
        break;
      }
    }

    if (turnFailure !== null) {
      throw turnFailure;
    }

    return { items, finalResponse, usage };
  }

  private async *runStreamedInternal(
    input: Input,
    turnOptions: TurnOptions,
  ): AsyncGenerator<ThreadEvent> {
    turnOptions.signal?.throwIfAborted();

    const queue = new AsyncQueue<ThreadEvent>();
    const state: AppServerTurnState = {
      threadId: null,
      turnId: null,
      usage: null,
      itemsById: new Map(),
    };

    let abortListener: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let turnId: string | null = null;
    let turnFinished = false;
    let interruptSent = false;

    const interruptActiveTurn = () => {
      if (this._id === null || turnId === null || turnFinished || interruptSent) {
        return;
      }
      interruptSent = true;
      void this.connection
        .request("turn/interrupt", {
          threadId: this._id,
          turnId,
        })
        .catch(() => undefined);
    };

    try {
      const wasNewThread = this._id === null;
      await this.ensureThread(turnOptions.signal);
      turnOptions.signal?.throwIfAborted();

      if (this._id === null) {
        throw new Error("Codex app-server did not return a thread id.");
      }

      state.threadId = this._id;
      unsubscribe = this.connection.subscribe((message) =>
        handleTurnNotification(message, state, queue),
      );

      if (wasNewThread) {
        queue.push({ type: "thread.started", thread_id: this._id });
      }

      abortListener = this.attachAbortListener(turnOptions.signal, queue, interruptActiveTurn);
      turnOptions.signal?.throwIfAborted();

      const startTurnPromise = this.connection.request("turn/start", {
        threadId: this._id,
        input: normalizeInput(input),
        outputSchema: turnOptions.outputSchema ?? null,
        ...turnOverrideParams(this.threadOptions),
      });
      if (turnOptions.signal !== undefined) {
        void startTurnPromise
          .then((startTurn) => {
            if (turnOptions.signal?.aborted !== true || this._id === null) {
              return;
            }
            const completedTurnId = getString(getRecord(startTurn, "turn"), "id");
            if (completedTurnId === undefined) {
              return;
            }
            void this.connection
              .request("turn/interrupt", {
                threadId: this._id,
                turnId: completedTurnId,
              })
              .catch(() => undefined);
          })
          .catch(() => undefined);
      }

      const startTurn = await rejectOnAbort(startTurnPromise, turnOptions.signal);
      const turn = getRecord(startTurn, "turn");
      const turnIdValue = getString(turn, "id");
      if (turnIdValue === undefined) {
        throw new Error("Codex app-server did not return a turn id.");
      }
      turnId = turnIdValue;
      state.turnId = turnId;
      turnOptions.signal?.throwIfAborted();

      for await (const event of queue) {
        if (isTerminalTurnEvent(event)) {
          turnFinished = true;
        }
        turnOptions.signal?.throwIfAborted();
        yield event;
      }
    } finally {
      interruptActiveTurn();
      abortListener?.();
      unsubscribe?.();
    }
  }

  private async ensureThread(signal: AbortSignal | undefined): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this._id === null) {
      const result = await rejectOnAbort(
        this.connection.request("thread/start", threadStartParams(this.threadOptions)),
        signal,
      );
      const thread = getRecord(result, "thread");
      const threadId = getString(thread, "id");
      if (threadId === undefined) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      this._id = threadId;
    } else {
      await rejectOnAbort(
        this.connection.request("thread/resume", {
          threadId: this._id,
          ...threadResumeParams(this.threadOptions),
        }),
        signal,
      );
    }

    this.initialized = true;
  }

  private attachAbortListener(
    signal: AbortSignal | undefined,
    queue: AsyncQueue<ThreadEvent>,
    interruptActiveTurn: () => void,
  ): (() => void) | undefined {
    if (signal === undefined) {
      return undefined;
    }

    const abort = () => {
      interruptActiveTurn();
      queue.fail(abortError(signal));
    };

    if (signal.aborted) {
      abort();
      return undefined;
    }

    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }
}

class AppServerConnection {
  private nextId = 0;
  private initialized: Promise<void> | null = null;
  private readLoopStarted = false;
  private closed = false;
  private transportClose: Promise<void> | null = null;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();

  constructor(
    private readonly transport: AppServerTransport,
    private readonly approvals: {
      approvalHandler?: CodexAppServerApprovalHandler;
      defaultApprovalDecision: CodexAppServerDefaultApprovalDecision;
    },
  ) {}

  subscribe(handler: (message: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error("Codex app-server connection closed.");
    }
    await this.ensureInitialized();
    if (this.closed) {
      throw new Error("Codex app-server connection closed.");
    }
    return this.sendRequest(method, params);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.failConnection(new Error("Codex app-server connection closed."));
    }
    await this.closeTransport();
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialized !== null) {
      return this.initialized;
    }

    this.startReadLoop();
    this.initialized = (async () => {
      await this.sendRequest("initialize", {
        clientInfo: {
          name: "langchain_codex",
          title: "langchain-codex",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.transport.send({ method: "initialized" });
    })();

    return this.initialized;
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server connection closed."));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = params === undefined ? { method, id } : { method, id, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private startReadLoop(): void {
    if (this.readLoopStarted) {
      return;
    }
    this.readLoopStarted = true;

    void (async () => {
      try {
        for await (const message of this.transport.messages) {
          this.handleMessage(message as JsonRpcMessage);
        }
        if (!this.closed) {
          this.failConnection(new Error("Codex app-server connection closed."));
        }
      } catch (error) {
        if (!this.closed) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          this.failConnection(normalized);
        }
      }
    })();
  }

  private failConnection(error: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    this.emitError(error);
  }

  private closeTransport(): Promise<void> {
    this.transportClose ??= (async () => {
      await this.transport.close();
    })();
    return this.transportClose;
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isServerRequest(message)) {
      void this.handleServerRequest(message).catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.emitError(normalized, message.params);
      });
      return;
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.id}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcServerRequest): Promise<void> {
    if (isApprovalRequestMethod(message.method)) {
      try {
        const decision = await this.resolveApprovalDecision(message);
        this.transport.send({ id: message.id, result: { decision } });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.transport.send({
          id: message.id,
          error: {
            code: -32000,
            message: normalized.message,
          },
        });
        this.emitError(normalized, message.params);
      }
      return;
    }

    if (isDynamicToolRequestMethod(message.method)) {
      const error = new Error(
        "Codex App Server dynamic tools are not supported by ChatCodexSDK. Use ChatCodexSDK.bindTools() for LangChain-standard tool calls.",
      );
      this.transport.send({
        id: message.id,
        error: {
          code: -32601,
          message: error.message,
        },
      });
      this.emitError(error, message.params);
      return;
    }

    this.transport.send({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported Codex app-server request: ${message.method}`,
      },
    });
  }

  private async resolveApprovalDecision(
    message: JsonRpcServerRequest,
  ): Promise<CodexAppServerApprovalDecision> {
    const handlerDecision = await this.approvals.approvalHandler?.({
      kind: approvalRequestKind(message.method),
      method: message.method,
      params: message.params,
    });
    const decision = handlerDecision ?? this.approvals.defaultApprovalDecision;

    if (decision === "throw") {
      throw new Error(
        `Codex app-server requested ${approvalRequestKind(message.method)} approval, but no appServerApprovalHandler is configured.`,
      );
    }

    if (!isApprovalDecision(decision)) {
      throw new Error(`Invalid Codex app-server approval decision: ${String(decision)}`);
    }

    return decision;
  }

  private emitError(error: Error, routingParams?: unknown): void {
    const params: Record<string, unknown> = {
      message: error.message,
      error: { message: error.message },
    };
    const routing = getRecord(routingParams);
    const threadId = getString(routing, "threadId");
    const turnId = getString(routing, "turnId");
    if (threadId !== undefined) {
      params.threadId = threadId;
    }
    if (turnId !== undefined) {
      params.turnId = turnId;
    }

    const message: JsonRpcNotification = {
      method: "error",
      params,
    };

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }
}

class StdioAppServerTransport implements AppServerTransport {
  readonly messages: AsyncIterable<unknown>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrChunks: Buffer[] = [];
  private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly closePromise: Promise<void>;
  private childClosed = false;
  private spawnError: unknown = null;

  constructor(options: CodexOptions) {
    const command = options.codexPathOverride ?? process.execPath;
    const args =
      options.codexPathOverride === undefined
        ? [resolveCodexEntrypoint(), ...buildAppServerArgs(options)]
        : buildAppServerArgs(options);
    const env = buildEnvironment(options);

    this.child = spawn(command, args, { env });
    this.child.once("error", (error) => {
      this.spawnError = error;
    });
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.closePromise = new Promise((resolve) => {
      this.child.once("close", () => {
        this.childClosed = true;
        resolve();
      });
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
    });
    this.messages = this.readMessages();
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (!this.child.killed && !this.childClosed) {
      this.child.kill();
    }
    await this.closePromise;
  }

  private async *readMessages(): AsyncGenerator<unknown> {
    const rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    try {
      if (this.spawnError !== null) {
        throw normalizeSpawnError(this.spawnError);
      }

      for await (const line of rl) {
        yield JSON.parse(line) as JsonRpcMessage;
      }

      if (this.spawnError !== null) {
        throw normalizeSpawnError(this.spawnError);
      }

      const { code, signal } = await this.exit;
      if (code !== 0 || signal !== null) {
        const detail = signal === null ? `code ${code ?? 1}` : `signal ${signal}`;
        const stderr = Buffer.concat(this.stderrChunks).toString("utf8").trim();
        throw new Error(
          `Codex app-server exited with ${detail}${stderr.length > 0 ? `: ${stderr}` : ""}`,
        );
      }
    } finally {
      rl.close();
    }
  }
}

type AppServerTurnState = {
  threadId: string | null;
  turnId: string | null;
  usage: Usage | null;
  itemsById: Map<string, ThreadItem>;
};

function handleTurnNotification(
  message: JsonRpcNotification,
  state: AppServerTurnState,
  queue: AsyncQueue<ThreadEvent>,
): void {
  const params = isRecord(message.params) ? message.params : {};
  const threadId = getString(params, "threadId");
  if (state.threadId !== null && threadId !== undefined && threadId !== state.threadId) {
    return;
  }

  const eventTurnId = getString(params, "turnId") ?? getString(getRecord(params, "turn"), "id");
  if (state.turnId !== null && eventTurnId !== undefined && eventTurnId !== state.turnId) {
    return;
  }

  if (state.turnId === null && eventTurnId !== undefined) {
    state.turnId = eventTurnId;
  }

  switch (message.method) {
    case "turn/started":
      queue.push({ type: "turn.started" });
      return;
    case "item/started":
      emitItemEvent("item.started", params, state, queue);
      return;
    case "item/completed":
      emitItemEvent("item.completed", params, state, queue);
      return;
    case "item/agentMessage/delta":
      emitAccumulatedTextItem(params, state, queue, "agent_message");
      return;
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      emitAccumulatedTextItem(params, state, queue, "reasoning");
      return;
    case "item/commandExecution/outputDelta":
      emitCommandOutputDelta(params, state, queue);
      return;
    case "thread/tokenUsage/updated":
      state.usage = normalizeAppServerUsage(getRecord(params, "tokenUsage"));
      return;
    case "turn/completed":
      emitTurnCompleted(params, state, queue);
      return;
    case "error": {
      const error = getRecord(params, "error");
      if (getBoolean(params, "willRetry") === true) {
        return;
      }
      queue.push({
        type: "error",
        message:
          getString(error, "message") ?? getString(params, "message") ?? "Codex app-server error.",
      });
      queue.close();
      return;
    }
    default:
      return;
  }
}

function emitItemEvent(
  type: "item.started" | "item.completed",
  params: Record<string, unknown>,
  state: AppServerTurnState,
  queue: AsyncQueue<ThreadEvent>,
): void {
  const item = normalizeAppServerItem(getRecord(params, "item"));
  if (item === undefined) {
    return;
  }
  state.itemsById.set(item.id, item);
  queue.push({ type, item });
}

function emitAccumulatedTextItem(
  params: Record<string, unknown>,
  state: AppServerTurnState,
  queue: AsyncQueue<ThreadEvent>,
  kind: "agent_message" | "reasoning",
): void {
  const itemId = getString(params, "itemId");
  const delta = getString(params, "delta");
  if (itemId === undefined || delta === undefined) {
    return;
  }

  const previous = state.itemsById.get(itemId);
  const previousText =
    previous?.type === "agent_message" || previous?.type === "reasoning" ? previous.text : "";
  const item =
    kind === "agent_message"
      ? ({ id: itemId, type: "agent_message", text: previousText + delta } as const)
      : ({ id: itemId, type: "reasoning", text: previousText + delta } as const);
  state.itemsById.set(itemId, item);
  queue.push({ type: "item.updated", item });
}

function emitCommandOutputDelta(
  params: Record<string, unknown>,
  state: AppServerTurnState,
  queue: AsyncQueue<ThreadEvent>,
): void {
  const itemId = getString(params, "itemId");
  const delta = getString(params, "delta");
  if (itemId === undefined || delta === undefined) {
    return;
  }

  const existing = state.itemsById.get(itemId);
  const item =
    existing?.type === "command_execution"
      ? ({
          ...existing,
          aggregated_output: `${existing.aggregated_output}${delta}`,
          status: existing.status === "completed" ? "completed" : "in_progress",
        } satisfies ThreadItem)
      : ({
          id: itemId,
          type: "command_execution",
          command: "",
          aggregated_output: delta,
          status: "in_progress",
        } as const);
  state.itemsById.set(itemId, item);
  queue.push({ type: "item.updated", item });
}

function emitTurnCompleted(
  params: Record<string, unknown>,
  state: AppServerTurnState,
  queue: AsyncQueue<ThreadEvent>,
): void {
  const turn = getRecord(params, "turn");
  const status = getString(turn, "status");

  if (status === "failed" || status === "interrupted") {
    const error = getRecord(turn, "error");
    queue.push({
      type: "turn.failed",
      error: {
        message:
          getString(error, "message") ??
          (status === "interrupted" ? "Codex turn interrupted." : "Codex turn failed."),
      },
    });
    queue.close();
    return;
  }

  queue.push({
    type: "turn.completed",
    usage: state.usage ?? {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
  });
  queue.close();
}

function isTerminalTurnEvent(event: ThreadEvent): boolean {
  return (
    event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error"
  );
}

function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Codex turn aborted.");
}

function normalizeAppServerItem(item: Record<string, unknown> | undefined): ThreadItem | undefined {
  if (item === undefined) {
    return undefined;
  }

  const id = getString(item, "id");
  const type = getString(item, "type");
  if (id === undefined || type === undefined) {
    return undefined;
  }

  switch (type) {
    case "agentMessage":
      return { id, type: "agent_message", text: getString(item, "text") ?? "" };
    case "reasoning":
      return {
        id,
        type: "reasoning",
        text: [...getStringArray(item.summary), ...getStringArray(item.content)].join("\n"),
      };
    case "commandExecution":
      return normalizeCommandExecutionItem(id, item);
    case "fileChange": {
      const status = normalizePatchStatus(getString(item, "status"));
      if (status === undefined) {
        return undefined;
      }
      return {
        id,
        type: "file_change",
        changes: getArray(item.changes)
          .map((change) => normalizeFileChange(change))
          .filter((change): change is { path: string; kind: "add" | "delete" | "update" } =>
            change !== undefined,
          ),
        status,
      };
    }
    case "mcpToolCall":
      return normalizeMcpToolCallItem(id, item);
    case "webSearch":
      return { id, type: "web_search", query: getString(item, "query") ?? "" };
    default:
      return item as unknown as ThreadItem;
  }
}

function normalizeCommandExecutionItem(
  id: string,
  item: Record<string, unknown>,
): Extract<ThreadItem, { type: "command_execution" }> {
  const commandItem: Extract<ThreadItem, { type: "command_execution" }> = {
    id,
    type: "command_execution",
    command: getString(item, "command") ?? "",
    aggregated_output: getString(item, "aggregatedOutput") ?? "",
    status: normalizeCommandStatus(getString(item, "status")),
  };
  const exitCode = getNumber(item, "exitCode");
  if (exitCode !== undefined) {
    commandItem.exit_code = exitCode;
  }
  return commandItem;
}

function normalizeMcpToolCallItem(
  id: string,
  item: Record<string, unknown>,
): Extract<ThreadItem, { type: "mcp_tool_call" }> {
  const mcpItem: Extract<ThreadItem, { type: "mcp_tool_call" }> = {
    id,
    type: "mcp_tool_call",
    server: getString(item, "server") ?? "",
    tool: getString(item, "tool") ?? "",
    arguments: item.arguments,
    status: normalizeMcpStatus(getString(item, "status")),
  };
  const result = normalizeMcpResult(getRecord(item, "result"));
  if (result !== undefined) {
    mcpItem.result = result;
  }
  const error = normalizeMcpError(getRecord(item, "error"));
  if (error !== undefined) {
    mcpItem.error = error;
  }
  return mcpItem;
}

function normalizeFileChange(
  value: unknown,
): { path: string; kind: "add" | "delete" | "update" } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pathValue = getString(value, "path");
  const kind = normalizeFileChangeKind(value.kind);
  if (
    pathValue === undefined ||
    (kind !== "add" && kind !== "delete" && kind !== "update")
  ) {
    return undefined;
  }
  return { path: pathValue, kind };
}

function normalizeFileChangeKind(value: unknown): "add" | "delete" | "update" | undefined {
  if (value === "add" || value === "delete" || value === "update") {
    return value;
  }

  if (isRecord(value)) {
    const type = getString(value, "type");
    if (type === "add" || type === "delete" || type === "update") {
      return type;
    }
  }

  return undefined;
}

function normalizeMcpResult(result: Record<string, unknown> | undefined) {
  if (result === undefined) {
    return undefined;
  }
  return {
    content: getArray(result.content) as never,
    structured_content: result.structuredContent,
  };
}

function normalizeMcpError(error: Record<string, unknown> | undefined) {
  if (error === undefined) {
    return undefined;
  }
  return { message: getString(error, "message") ?? "MCP tool call failed." };
}

function normalizeCommandStatus(
  status: string | undefined,
): Extract<ThreadItem, { type: "command_execution" }>["status"] {
  if (status === "completed" || status === "failed") {
    return status;
  }
  if (status === "declined") {
    return "failed";
  }
  return "in_progress";
}

function normalizeMcpStatus(
  status: string | undefined,
): Extract<ThreadItem, { type: "mcp_tool_call" }>["status"] {
  if (status === "completed" || status === "failed") {
    return status;
  }
  return "in_progress";
}

function normalizePatchStatus(
  status: string | undefined,
): Extract<ThreadItem, { type: "file_change" }>["status"] | undefined {
  if (status === "failed" || status === "declined") {
    return "failed";
  }
  if (status === "inProgress" || status === "in_progress") {
    return undefined;
  }
  return "completed";
}

function normalizeAppServerUsage(tokenUsage: Record<string, unknown> | undefined): Usage | null {
  const last = getRecord(tokenUsage, "last");
  if (last === undefined) {
    return null;
  }

  return {
    input_tokens: getNumber(last, "inputTokens") ?? 0,
    cached_input_tokens: getNumber(last, "cachedInputTokens") ?? 0,
    output_tokens: getNumber(last, "outputTokens") ?? 0,
    reasoning_output_tokens: getNumber(last, "reasoningOutputTokens") ?? 0,
  };
}

function threadStartParams(options: ThreadOptions): Record<string, unknown> {
  return {
    model: options.model ?? null,
    cwd: options.workingDirectory ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    sandbox: options.sandboxMode ?? null,
    config: threadConfig(options),
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  };
}

function threadResumeParams(options: ThreadOptions): Record<string, unknown> {
  return {
    model: options.model ?? null,
    cwd: options.workingDirectory ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    sandbox: options.sandboxMode ?? null,
    config: threadConfig(options),
    persistExtendedHistory: true,
  };
}

function turnOverrideParams(options: ThreadOptions): Record<string, unknown> {
  return {
    model: options.model ?? null,
    cwd: options.workingDirectory ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    effort: options.modelReasoningEffort ?? null,
  };
}

function threadConfig(options: ThreadOptions): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const sandboxWorkspaceWrite: Record<string, unknown> = {};
  if (options.networkAccessEnabled !== undefined) {
    sandboxWorkspaceWrite.network_access = options.networkAccessEnabled;
  }
  if (options.additionalDirectories !== undefined) {
    sandboxWorkspaceWrite.writable_roots = options.additionalDirectories;
  }
  if (Object.keys(sandboxWorkspaceWrite).length > 0) {
    config.sandbox_workspace_write = sandboxWorkspaceWrite;
  }
  if (options.webSearchMode !== undefined) {
    config.web_search = options.webSearchMode;
  } else if (options.webSearchEnabled === true) {
    config.web_search = "live";
  } else if (options.webSearchEnabled === false) {
    config.web_search = "disabled";
  }
  return Object.keys(config).length === 0 ? null : config;
}

function normalizeInput(input: Input): Array<Record<string, unknown>> {
  if (typeof input === "string") {
    return [{ type: "text", text: input, text_elements: [] }];
  }

  return input.map((entry) => {
    if (entry.type === "text") {
      return { type: "text", text: entry.text, text_elements: [] };
    }

    return { type: "localImage", path: entry.path };
  });
}

function buildAppServerArgs(options: CodexOptions): string[] {
  const args = ["app-server"];
  if (options.config !== undefined) {
    for (const override of serializeConfigOverrides(options.config)) {
      args.push("--config", override);
    }
  }
  if (options.baseUrl !== undefined) {
    args.push("--config", `openai_base_url=${toTomlValue(options.baseUrl, "openai_base_url")}`);
  }
  return args;
}

function buildEnvironment(options: CodexOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (options.env !== undefined) {
    Object.assign(env, options.env);
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
  }
  env[INTERNAL_ORIGINATOR_ENV] ??= APP_SERVER_ORIGINATOR;
  if (options.apiKey !== undefined) {
    env.CODEX_API_KEY = options.apiKey;
  }
  return env;
}

function resolveCodexEntrypoint(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("@openai/codex/package.json");
  return path.join(path.dirname(packageJsonPath), "bin", "codex.js");
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return (
    isRecord(message) &&
    isJsonRpcId((message as { id?: unknown }).id) &&
    !("method" in message)
  );
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return (
    isRecord(message) &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in message)
  );
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcServerRequest {
  return (
    isRecord(message) &&
    typeof (message as { method?: unknown }).method === "string" &&
    isJsonRpcId((message as { id?: unknown }).id)
  );
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function isApprovalRequestMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  );
}

function isDynamicToolRequestMethod(method: string): boolean {
  return method === "item/tool/call";
}

function approvalRequestKind(method: string): "command" | "file_change" {
  return method === "item/commandExecution/requestApproval" ? "command" : "file_change";
}

function isApprovalDecision(value: unknown): value is CodexAppServerApprovalDecision {
  return (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  );
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined;
function getRecord(value: unknown): Record<string, unknown> | undefined;
function getRecord(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target = key === undefined ? value : isRecord(value) ? value[key] : undefined;
  return isRecord(target) ? target : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "number" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === "boolean" ? property : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serializeConfigOverrides(configOverrides: Record<string, unknown>): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}

function flattenConfigOverrides(value: unknown, prefix: string, overrides: string[]): void {
  if (!isPlainObject(value)) {
    if (prefix.length > 0) {
      overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return;
    }
    throw new Error("Codex config overrides must be a plain object");
  }

  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    if (key.length === 0) {
      throw new Error("Codex config override keys must be non-empty strings");
    }
    const childPath = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, childPath, overrides);
    } else {
      overrides.push(`${childPath}=${toTomlValue(child, childPath)}`);
    }
  }
}

function toTomlValue(value: unknown, keyPath: string): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${keyPath} must be a finite number`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${keyPath}[${index}]`)).join(", ")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child, `${keyPath}.${key}`)}`)
      .join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${keyPath}: ${typeof value}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeSpawnError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(error.message, { cause: error });
  }

  return new Error(
    typeof error === "string" ? error : "Unknown Codex app-server spawn error.",
  );
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.error = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ value, done: false });
    }
    if (this.error !== null) {
      return Promise.reject(this.error);
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as T, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}
