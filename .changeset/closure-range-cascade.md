---
"@opengeni/agent-proto": patch
"@opengeni/api-router": patch
"@opengeni/codex": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/documents": patch
"@opengeni/events": patch
"@opengeni/github": patch
"@opengeni/observability": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/storage": patch
"@opengeni/worker-bundle": patch
---

Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
