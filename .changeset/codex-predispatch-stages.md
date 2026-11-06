---
"@opengeni/worker-bundle": patch
---

Codex model requests spend less time before dispatch when the database is busy. Each Codex request already rechecks the connection source (under the per-connection lock) and the subscription lease (with a key-share read) inside its reservation transaction, but the dispatch hook first repeated both reads in separate transactions. Under a lock-contended database every extra round trip costs tens of milliseconds, so those two redundant transactions are gone: the hook now checks the in-memory lease state and known credit usage, then reserves. A lost lease found by the reservation still marks the lease lost. Title requests, which do not reserve, keep the full checks.

Pre-dispatch time is now exported per stage as `opengeni_model_request_pre_dispatch_stage_seconds{provider,stage}` (settlement_wait, admission, request_build, credential, dispatch_checkpoint, request_audit, provider_admission, transport). Stages are exclusive and sum to the existing pre-dispatch total. The pre-dispatch p95 alert and launch runbook point at it, so the slow stage can be read directly.
