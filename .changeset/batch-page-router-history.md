---
"@opengeni/db": patch
"@opengeni/core": patch
---

Read router-history presence for session response pages in one scoped transaction instead of one transaction per session. Preserve the indexed history predicate and existing effective-tool response fields.
