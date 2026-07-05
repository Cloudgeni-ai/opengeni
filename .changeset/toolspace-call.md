---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/core": patch
"@opengeni/documents": patch
"@opengeni/events": patch
"@opengeni/github": patch
"@opengeni/react": patch
"@opengeni/storage": patch
---

Add Toolspace programmatic tool access for sandboxes.

The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.
