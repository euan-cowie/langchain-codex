# Changelog

## 0.2.0

### Minor Changes

- d6edf13: Drop Node.js 18 support and require Node.js 20 or later.

  Add a Node 20/22 CI matrix, package smoke test, trusted publishing hardening, and standard open source project docs and templates.

### Patch Changes

- eeb2515: Remove the `zod-to-json-schema` dependency and use Zod v4's native JSON Schema conversion for structured output.
- 8ff2754: Add top-level package types metadata, export `package.json`, and document the ESM-only module format.

## 0.1.0

- Initial development release.
