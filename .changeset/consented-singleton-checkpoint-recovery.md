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
without blocking an independently selected Connected Machine. Additive migration
0495 keeps consent DB-disabled until operator-verified compatible rollout; permanent
consent receipts reject old inference claims even after disabling consent or lease
replacement. Only the warning-aware worker declares the scoped protocol.
Preserve explicit failed-turn Retry after verified recovery or Connected Machine
selection, and retain consent identity when post-accept status reads lose access.
Keep fresh migration-before-role-provisioning and later runtime-role provisioning
safe, with SELECT-only rollout access and owner-only activation.