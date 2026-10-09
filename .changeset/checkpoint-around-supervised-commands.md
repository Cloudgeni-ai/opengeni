---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Sandboxes running a supervised background command now get checkpoints. While a supervised command ran, every save of its box was refused, both the turn's periodic checkpoint and the idle checkpoint between turns. The box's only save was the mandatory one just before the provider deadline, so losing the box unexpectedly lost every change since the last turn. A Modal point-in-time checkpoint now runs around the command, the same way it does for unsupervised commands. The box and the command keep running. The checkpoint is a real restore point, saved one generation behind the workspace so it is never presented as complete. The database guard still refuses drains, containment and teardown of a supervised command without its exit receipt.
