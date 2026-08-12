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
instructions.