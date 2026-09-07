---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Park sandbox rotation recovery until durable lease progress, and wake the exact waiting turn when provider loss, failed warming, reaping, or teardown release ends its rotation wait.
