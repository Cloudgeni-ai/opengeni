---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Moving a session to another machine no longer rewrites the system prompt. The workspace root and filesystem layout reach the model as a `<opengeni_workspace_filesystem>` history item written before the turn that first sees a new layout, and `sandbox_swap` returns the new `workspaceRoot`, so the provider's prompt cache survives a swap.
