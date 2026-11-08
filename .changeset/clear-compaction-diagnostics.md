---
"@opengeni/worker-bundle": patch
"@opengeni/observability": patch
---

Report requested context checkpoints as normal transitions, preserve their trigger and size diagnostics, and distinguish context/request-size rejection and checkpoint failure from a generic worker failure. Compaction behavior and model inputs are unchanged.
