---
"@opengeni/sdk": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Revalidate live editor source-session authority in the mutation commit transaction, and enforce source-bound socket lease expiry independently of stalled authorization. Publish the session-proxy JavaScript entry and negotiate artifact support without breaking conversation bootstrap against older APIs.