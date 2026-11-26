---
"@opengeni/observability": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Sandbox reaper failures are diagnosable from logs. "sandbox reaper: per-sandbox drain failed" and "sandbox reaper: retained-process settlement failed" now record a protected failure diagnostic (throw site, process correlation) and log its `correlationId`, the hashed `sandboxLeaseKey`, lease epoch and backend, the cause's reviewed class, sandbox fence code (`causeFenceCode`) and SQLSTATE, and a one-way `causeFingerprint` of its message that `scripts/resolve-rejection-fingerprint.ts` maps back to the source literal. Before, both lines dropped their error entirely, and the settlement line carried no correlation at all.

A viewer attach (`POST /v1/workspaces/:workspaceId/sessions/:id/viewers`) whose caller disconnects while the attach waits on a sandbox lifecycle transition now answers 499 with no body, the client-gone convention, instead of logging a 500 `internal_error`.
