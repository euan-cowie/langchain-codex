import { describe, expect, it } from "vitest";
import { ChatCodexSDK } from "../../src/index.js";

const runIntegrationTests = process.env.RUN_CODEX_INTEGRATION_TESTS === "1";

describe.skipIf(!runIntegrationTests)("ChatCodexSDK integration", () => {
  it("invokes local Codex against the current repository", async () => {
    const model = new ChatCodexSDK({
      model: process.env.CODEX_INTEGRATION_MODEL ?? "gpt-5.4",
      workingDirectory: process.cwd(),
      sandboxMode: "read-only",
    });

    const response = await model.invoke("Reply with a short JSON-free sentence.");

    expect(typeof response.text).toBe("string");
    expect(response.text.length).toBeGreaterThan(0);
  }, 120_000);
});
