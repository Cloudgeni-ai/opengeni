---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Allow embedding hosts to preallocate a session UUID before OpenGeni admits the
initial turn. Session creation preserves idempotent replays of the same UUID and
returns a conflict for UUID reuse or an idempotency replay that changes identity.
