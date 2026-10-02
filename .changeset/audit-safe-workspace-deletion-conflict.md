---
"@opengeni/api-router": patch
---

Return an actionable 409 rather than an internal error when retained or linked
records prevent workspace deletion. Preserve the failed transaction's rollback,
audit history, existing authorization and quiescence fences, and do not dispatch
external schedule cleanup. Document that no workspace retirement endpoint exists.