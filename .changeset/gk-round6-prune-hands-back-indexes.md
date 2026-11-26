---
"@opengeni/db": patch
---

Host export pruning and the end-of-turn hands-back check now use indexes, so they no longer read every grace-window outbox row or every active goal.
