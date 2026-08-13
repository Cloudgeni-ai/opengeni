---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
---

Allow trusted embedding hosts to preserve hidden exact-turn instructions across
realtime delegation and transcript-tail admission without exposing them through
the realtime ledger or timeline. Public HTTP callers must prove a distinct,
literal-only same-workspace host authority for every request carrying those
instructions. Mixed-version storage is fenced by a transaction-local protocol
marker, and the operator provisioner supports exact-RLS staged rotation plus
explicit post-acceptance finalization without a credential gap.