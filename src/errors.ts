export class CodexAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAdapterError";
  }
}

export class CodexAuthError extends CodexAdapterError {
  override name = "CodexAuthError";
}

export class CodexExecutableError extends CodexAdapterError {
  override name = "CodexExecutableError";
}

export class CodexGitRepositoryError extends CodexAdapterError {
  override name = "CodexGitRepositoryError";
}

export class CodexTimeoutError extends CodexAdapterError {
  override name = "CodexTimeoutError";
}

export class CodexUnsupportedFeatureError extends CodexAdapterError {
  override name = "CodexUnsupportedFeatureError";
}

export class CodexStructuredOutputError extends CodexAdapterError {
  override name = "CodexStructuredOutputError";
}

const AUTH_PATTERNS = [
  /not authenticated/i,
  /authentication/i,
  /unauthorized/i,
  /login/i,
  /api key/i,
  /CODEX_API_KEY/i,
];

const EXECUTABLE_PATTERNS = [
  /ENOENT/i,
  /command not found/i,
  /codex.*not found/i,
  /No such file or directory/i,
];

const GIT_PATTERNS = [/not a git repository/i, /working directory.*git/i, /skipGitRepoCheck/i];

const TIMEOUT_PATTERNS = [/timeout/i, /timed out/i, /aborted/i, /AbortError/i];

export function normalizeCodexError(error: unknown): Error {
  if (error instanceof CodexAdapterError) {
    return error;
  }

  const message = getErrorMessage(error);

  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return new CodexAuthError(
      [
        message,
        "",
        "Codex authentication is required. This package does not handle OAuth tokens directly; run `codex login` or configure Codex API-key auth before using ChatCodexSDK.",
      ].join("\n"),
      { cause: error },
    );
  }

  if (EXECUTABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return new CodexExecutableError(
      `Could not start the local Codex runtime. Make sure Codex is installed and available on PATH, or pass codexPathOverride. Original error: ${message}`,
      { cause: error },
    );
  }

  if (GIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return new CodexGitRepositoryError(
      `Codex requires a git working directory by default. Pass skipGitRepoCheck: true only when you intentionally want to run outside a git repository. Original error: ${message}`,
      { cause: error },
    );
  }

  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))) {
    return new CodexTimeoutError(
      `Codex turn timed out or was aborted. Original error: ${message}`,
      {
        cause: error,
      },
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new CodexAdapterError(message, { cause: error });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }

  return String(error);
}
