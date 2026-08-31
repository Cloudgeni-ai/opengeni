---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without native delegation, catalog, or reconnect flows reinterpreting it.