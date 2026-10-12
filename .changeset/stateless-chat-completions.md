---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Add a stateless OpenAI-compatible Chat Completions endpoint for single model calls without tools (`POST /v1/workspaces/:workspaceId/chat/completions`, `GET /v1/workspaces/:workspaceId/models`). Calls route through the workspace model catalog, including Codex, Claude and SuperGrok subscription accounts, admit on a positive credit balance, and settle actual usage once per request. Session titles use the same single-call path and stay on the turn's subscription account (Codex titles with `codex/gpt-6-luna`, Claude with Haiku 5.5).
