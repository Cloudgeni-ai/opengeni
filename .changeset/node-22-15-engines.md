---
"@opengeni/core": patch
"@opengeni/storage": patch
"@opengeni/documents": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Require Node.js 22.15 or later (`engines.node`) for the packages that load `@opengeni/storage`, which uses zlib's zstd streams; on older Node versions the import fails.
