---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Correct oversized session-message continuation with bounded source slicing, preserve typed runner terminal failures during command observation, and keep retained command output readable when live refresh encounters a recognized temporary transport failure. Refresh fallback rechecks API authorization and explicitly marks unavailable freshness; it does not mask integrity or authorization errors.