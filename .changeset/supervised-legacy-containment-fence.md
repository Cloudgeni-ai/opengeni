---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep supervised commands out of legacy observation-error containment, including
stale enrollment, checkpoint publication and published-capture teardown retries.
Fence older control writers at the database boundary before enabling supervision.