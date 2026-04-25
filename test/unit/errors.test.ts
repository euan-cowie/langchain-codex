import { describe, expect, it } from "vitest";
import {
  CodexAuthError,
  CodexExecutableError,
  CodexGitRepositoryError,
  CodexTimeoutError,
  normalizeCodexError,
} from "../../src/index.js";

describe("normalizeCodexError", () => {
  it("normalizes common auth failures", () => {
    expect(normalizeCodexError(new Error("not authenticated"))).toBeInstanceOf(CodexAuthError);
  });

  it("normalizes missing executable failures", () => {
    expect(normalizeCodexError(new Error("spawn codex ENOENT"))).toBeInstanceOf(
      CodexExecutableError,
    );
  });

  it("normalizes git repository failures", () => {
    expect(normalizeCodexError(new Error("not a git repository"))).toBeInstanceOf(
      CodexGitRepositoryError,
    );
  });

  it("normalizes timeout failures", () => {
    expect(normalizeCodexError(new Error("operation timed out"))).toBeInstanceOf(CodexTimeoutError);
  });
});
