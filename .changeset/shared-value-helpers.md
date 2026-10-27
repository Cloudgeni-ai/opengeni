---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/artifact-tool": patch
---

Internal cleanup with no behaviour change. `@opengeni/contracts/values` holds the shared `isRecord`, `errorMessage` and `sha256Hex` helpers that packages had each copied, the database package walks nested driver errors with one shared generator, and the SDK's three workspace streams share one reconnecting stream loop.
