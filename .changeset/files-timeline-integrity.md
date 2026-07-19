---
"@opengeni/storage": minor
"@opengeni/contracts": minor
"@opengeni/sdk": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/documents": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

Make cold workspace captures and session replay fail truthfully instead of exposing stale or
misordered state. Object storage implementations now expose raw-key metadata lookup, Channel-A
enumerates nested untracked files, capture after-images are byte-stabilized before persistence,
session SSE failures terminate cleanly for exact-cursor reconnect, and capture stabilization
exhaustion publishes an explicit degraded revision instead of leaving an older successful capture
looking current. Persistent repository-inspection failures and the whole-capture size guard also
publish fenced degraded revisions rather than exposing incomplete or stale projections.
