---
"@opengeni/core": patch
"@opengeni/db": patch
---

Reuse public workspace connection metadata within each model catalog or admission-input load to avoid a second direct-provider query. Preserve per-request scope, private connection filtering, fresh admission boundaries, and standalone or transaction-scoped fallback reads.
