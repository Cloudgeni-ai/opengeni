---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/codemode": patch
---

A turn paused or cancelled while a platform setup command runs no longer stalls its finalization. The setup command's registered shell kept the turn's cancellation signal on the reads the writer drain uses to prove the command exited, so after the cancel every proof read was refused, and a command that had already exited on its own could never be proven settled; the drain now reads without that signal, as it does for ordinary shells. A worker contained by a stalled finalizer now stops cleanly once every other in-flight turn has settled or checkpointed, instead of running into the Temporal SDK force stop, whose native worker finalization fails with "Worker still in use" while the stalled activity keeps its poll open, and exiting non-zero. Each containment request is a hold the finalizer releases if its stage recovers, so a worker never stops under a live turn. `CodemodeClient` treats `agent_attempt_caller_stale` as permanent for that bearer: later requests with the same bearer, from any client in the process, fail locally with the same non-retryable refusal instead of reaching the API again, while a renewed bearer is tried normally (`isCodemodeCallerStaleError`).
