---
"@opengeni/db": patch
---

Acquire canonical lifecycle parent locks before reserving image operations and artifacts, preventing foreign-key lock-order deadlocks with turn settlement regardless of catalog trigger order.
