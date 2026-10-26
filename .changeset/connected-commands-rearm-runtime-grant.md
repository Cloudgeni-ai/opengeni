---
"@opengeni/db": patch
---

Rolling migration 1101 grants the runtime role EXECUTE on the connected-command re-arm that 0984 created withheld, and readiness now requires it. A Connected Machine runner that reports its inventory again makes the running commands it never answered for due right away, so they settle on the next reconciler pass instead of waiting for a repair. The caller no longer checks the grant first.
