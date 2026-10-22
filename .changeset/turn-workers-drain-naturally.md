---
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Rolling deploys no longer restart running agent turns. A turn worker that is shutting down stops taking new work at once and lets its in-flight turns finish normally for up to 90 seconds (`OPENGENI_TURN_WORKER_SHUTDOWN_GRACE_MS`) before checkpointing any remaining turn for recovery on another worker; the Temporal force stop follows at 105 seconds (`OPENGENI_TURN_WORKER_SHUTDOWN_FORCE_MS`). Control workers keep their 5-second natural window. The worker process now exits as soon as its drain and resource cleanup finish instead of waiting for leftover open handles, so old pods no longer stay `Terminating` until Kubernetes kills them. The Helm chart surges a replacement turn pod before removing an old one and renders both settings from `worker.turns.shutdown`, derived from the turn pod's termination grace (120 seconds by default) when unset.
