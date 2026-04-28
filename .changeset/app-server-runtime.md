---
"langchain-codex": minor
---

Add an experimental `runtime: "app-server"` backend that drives Codex through `codex app-server`, with JSON-RPC stdio process management, streamed event normalization, usage mapping, conservative approval handling, and `ChatCodexSDK.close()` for process cleanup.
