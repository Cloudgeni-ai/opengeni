---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": patch
---

Add message action slots and an optional source message boundary for managed-human forks. The web UI places turn feedback and Fork from here beside Copy and the timestamp. Message forks preserve existing authorization and idempotency, copy only the selected canonical history prefix, and reject ambiguous, compacted, or incomplete boundaries.

Migration 0429 requires draining the API and both worker pools and provisioning the updated runtime routine contract before starting the new binary.
