---
"@opengeni/db": patch
---

Checkpoint garbage collection is much cheaper. The claim, tombstone prune and due probe now check each artifact's lease references with index probes on the private lease projection, instead of reading every row-secured lease row on each tick. New indexes cover the lease references and the artifact state. The lease liveness and checkpoint state gauges now count the projections, so they report real counts. Before, as their row-secured owner, they saw no rows.
