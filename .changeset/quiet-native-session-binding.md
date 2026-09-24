---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": minor
---

Allow authenticated hosts to replace an existing session MCP attachment with an accessible native connection through the standalone credential rotation API. An optional explicit replacement URL must match the native account's stored destination while the old URL remains a compare-and-set precondition. Preserve resource restrictions, version fencing, quiescence and idempotent receipts without replacing session history or accepted-attempt identity.