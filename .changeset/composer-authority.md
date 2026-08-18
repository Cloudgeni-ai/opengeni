---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Separate new-session and established-session composer policy authority. Exact draft submission now atomically freezes queued-turn text, resources, model, reasoning, and latency, then rotates the server draft; queue Edit restores that exact snapshot and stale revisions surface as conflicts instead of silent rebases.
