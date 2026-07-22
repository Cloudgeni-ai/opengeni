---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Persist and expose one immutable subject-or-service initiator for every accepted turn, including creator-safe idempotent repair, queue-edit preservation, exact live-attempt fencing for agent-created sessions, signed agent inheritance, causally dominant Agent Steer attribution, explicit service producers, rolling legacy backfill, and database-enforced immutability.
Bounded agent provenance now retains its first causal hop together with the
newest hops, so deep child chains do not discard their root authority when the
middle of the audit path is truncated.
