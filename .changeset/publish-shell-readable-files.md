---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
---

`sandbox_file_publish` publishes any file the agent's own shell can read, such as scratch output in `/tmp`, on managed sandboxes and Connected Machines alike, instead of refusing every path outside the workspace root. A managed box reads the file through its shell and a Connected Machine at its host path; the workspace root is only the base for relative paths, and a workspace file keeps its existing artifact identity. Callers that cannot run the session's shell (no agent attempt of that session and no `terminal:attach`) keep the workspace scope of their file reads.

A first-party tool that refuses the caller's own arguments (a schema mismatch, a bad field combination, an unknown ID, an API 400/422) now records `outcome="rejected"` in `opengeni_mcp_tool_calls_total` instead of `provider_declared_error`, and `OpenGeniMcpToolFailureRatio` leaves rejected calls out of both its failures and its total. The server marks the result in `_meta`; the worker honors the mark only from the first-party server and removes it, so the result the caller sees is unchanged.
