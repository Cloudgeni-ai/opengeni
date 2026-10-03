---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Reserve monthly usage capacity before provider dispatch, reconcile usage and credit debits atomically, and retain unresolved call holds across retries and closure. Apply admission to compaction and title requests, bound output, and prevent hidden SDK retries from replaying paid work. Preserve current export and organization analytics behavior while excluding internal reservation facts.
