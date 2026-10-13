---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove the legacy SuperGrok subscription runtime now that SuperGrok runs only on the shared subscription core. The old SuperGrok account repository, its waiters, leases, pins, legacy quota refresh, organization surface, API authorization helper, legacy video token envelope and shadow comparison are deleted; a SuperGrok request that does not reach the shared core fails closed, as it does during maintenance. The stateless Chat Completions API (`GET /v1/workspaces/:workspaceId/models`, `POST .../chat/completions`) no longer lists or serves SuperGrok subscription models, because the shared core's single-call operation is Codex-only; a request for one answers `model_not_found`. A SuperGrok video operation whose stored credential is not a shared-core connection reference now ends at its recovery deadline instead of retrying. The legacy tables stay read-only. Claude is unchanged. Rolling change; no migration.
