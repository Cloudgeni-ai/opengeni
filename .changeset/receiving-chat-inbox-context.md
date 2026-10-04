---
"@opengeni/db": patch
"@opengeni/contracts": patch
---

Use the receiving chat's accepted execution context for ordinary same-user agent updates, so different sender account selections do not fragment batches or change the receiving chat's accounts. Preserve explicit authorization for other users and restricted sources, and add factual model-only notes for known tool selection differences.
