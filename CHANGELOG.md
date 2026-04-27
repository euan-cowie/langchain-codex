# Changelog

## 0.3.0

### Minor Changes

- c4ec7e9: Add experimental prompt-mediated `bindTools()` support that returns LangChain tool calls from Codex structured output.
- af21862: Expose a conservative LangChain model profile and verify experimental tool calls against LangGraph ToolNode workflows.
- 00e6e49: Surface Codex runtime activity through LangChain content blocks and custom stream events.

### Patch Changes

- 52d8c4f: Remove stale v0.1 wording from published README guidance and unsupported-feature errors.

## 0.2.0

### Minor Changes

- d6edf13: Drop Node.js 18 support and require Node.js 20 or later.

  Add a Node 20/22 CI matrix, package smoke test, trusted publishing hardening, and standard open source project docs and templates.

### Patch Changes

- eeb2515: Remove the `zod-to-json-schema` dependency and use Zod v4's native JSON Schema conversion for structured output.
- 8ff2754: Add top-level package types metadata, export `package.json`, and document the ESM-only module format.

## 0.1.0

- Initial development release.
