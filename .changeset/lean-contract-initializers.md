---
"@opengeni/contracts": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

Allow release bundlers to remove unused contract validators, including their nested schema construction. Used schemas remain eager, retain their exact validation and JSON-schema behavior, and add no first-request initialization work.
