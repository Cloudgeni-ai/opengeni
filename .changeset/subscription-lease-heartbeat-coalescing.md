---
"@opengeni/worker": patch
---

Reuse fresh subscription lease confirmations between runtime and usage checkpoints to avoid redundant database heartbeats. Preserve the independent timer, expiry checks, exact ownership fences, and immediate retry after failed renewal.
