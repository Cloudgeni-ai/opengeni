---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/runtime": patch
---

Refresh write-only session MCP headers atomically when accepting approval and
human-input responses. The embedding session proxy now runs its existing
credential hook on both response kinds, including through framework adapters,
so a human can resume a waiting turn after its original tool token expires.
Preserve response authority, encrypted/versioned storage, secret-free events,
and replay semantics; synchronize the client integration Skill guidance.