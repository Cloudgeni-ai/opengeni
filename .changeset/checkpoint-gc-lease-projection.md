---
"@opengeni/db": patch
---

Checkpoint garbage collection is much cheaper. The claim, the tombstone prune and the due probe check each artifact's lease references with index probes on the private lease projection. Before, every tick read the whole lease table, a large, heavily updated table. The lease liveness and checkpoint state gauges count the projections as well, and report the same counts. New indexes cover the lease references (used by the checkpoint reference validator) and the tombstone prune.
