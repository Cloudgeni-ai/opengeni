---
"@opengeni/db": patch
---

Console agents publishes: a move of running chats that a newer publish takes over ends `succeeded` with `failureReason: "superseded"`, and listing an agent's publish operations restarts (or fails with a reason) a move left `pending` for over two minutes. A Console create now takes the same per-key lock as code deploys and inline saves.
