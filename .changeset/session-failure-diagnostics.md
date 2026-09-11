---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Expose bounded current-failure evidence on session detail reads so recovery diagnostics do not depend on timeline pagination. Show recorded consecutive retry streaks without inventing lifetime totals, and distinguish Codex account assignment, affinity/lease reuse, and actual switches without changing allocation policy.
