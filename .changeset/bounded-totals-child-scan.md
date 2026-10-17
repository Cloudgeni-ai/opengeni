---
"@opengeni/db": patch
---

Materialize RLS-authorized child metadata once for session list totals so deep trees do not rescan the sessions table at each recursive step. Preserve exact-target scope, private visibility and existing scan budgets.
