---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": patch
---

Let agent-created child sessions inherit omitted repository, MCP tool, and
per-session MCP server context from their trusted immediate parent. Explicit
arrays remain authoritative, mixed Git providers and multiple bindings are
preserved, and credential headers are copied only as encrypted ciphertext.
