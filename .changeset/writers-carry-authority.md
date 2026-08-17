---
"@opengeni/db": minor
"@opengeni/core": minor
---

Every persistable /workspace writer admission and retained process now freezes its exact authority tuple (causal initiator, initiating human, organization-membership grant identity with observed revision, and session tenancy epoch/visibility/owner). Direct and process actors are fenced like turns: a revoked or suspended grant, or an unattributed pre-0276 tenancy half, fails a new mutation closed before any workspace generation is consumed, and the running provider process is never terminated or re-owned.
