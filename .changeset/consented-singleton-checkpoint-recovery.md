---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
---

Add explicit managed-human consent for same-session singleton Modal recovery from
an exact older CURRENT checkpoint. Protect membership, route and artifact identity,
retain durable replay receipts and generation provenance, and reconstruct a model
warning before later inference. Separate consent from verified restoration and
never replay failed commands. Refuse Retry on an unchanged blocked effective route
without blocking an independently selected Connected Machine. Requires maintenance
migration 0492; pre-migration workers cannot safely coexist with public consent.