---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/documents": minor
"@opengeni/sdk": minor
---

Add an explicit, replay-safe Document authority-reclassification lifecycle and
a resumable organization Default-collection backfill. Reclassification requires
the exact expected authority tuple, updates the Document and every chunk in one
transaction, and retains immutable before/after receipts. The SDK and API expose
the account-admin and actor-fenced operations, bounded cursor-paginated receipt
history, and same-organization portable-personal behavior without making
collections an authority boundary.
