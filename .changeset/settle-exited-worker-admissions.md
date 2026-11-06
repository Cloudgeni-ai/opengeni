---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A session no longer stays stuck when its turn worker goes away in the middle of a tool call. Before, only owned-box setup that a shutting-down worker left open was settled, so a file write, editor change, command or stdin request cut off by a worker restart kept `reconcileSessionAttemptQuiescence` answering `pending` on every wake, and neither the interrupted turn nor queued messages ever ran. Once Temporal proves the attempt's activity settled and the turn worker's process-exit deadline has passed since its `worker_shutdown` closure or its worker-death closure (`lease_lost_recoverable`, or `failed` after the redispatch limit), every one of the attempt's own requests that has no holder and no retained process is settled `rejected` (never replayed), and the session is woken so the interrupted turn resumes or the next input runs. Pause, Steer, cancellation, other closures, retained commands and setup with a recorded-unknown start keep their gate.
