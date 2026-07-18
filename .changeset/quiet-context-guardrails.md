---
"@opengeni/api-router": patch
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Bound model-facing textual tool output with Codex-compatible semantics, account
for complete current model input, make compaction failure/progress transitions
durable and convergent, and replace recursive session discovery with a compact
paginated projection.
