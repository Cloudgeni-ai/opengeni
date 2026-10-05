---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Harden artifact delivery, relay stream control, human tool approval, and API rate-limit source attribution.

Bound managed login transaction leases using the database clock while preserving their exact durable expiry.
