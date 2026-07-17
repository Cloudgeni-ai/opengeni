---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep failed-child result provenance owned by the atomic turn settlement. Worker activities now read and deliver the exact committed outbox row without rewriting its turn-scoped payload or lineage.
