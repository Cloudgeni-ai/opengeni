---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/events": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Keep backward session-history pagination advancing across oversized legacy events by applying the canonical bounded read projection instead of failing the page, and report when a forensic response is no longer byte-for-byte exact.
