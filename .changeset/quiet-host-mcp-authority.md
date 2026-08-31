---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without mirroring provider connections into OpenGeni.