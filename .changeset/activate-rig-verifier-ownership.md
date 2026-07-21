---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Add the second-phase, default-off rig-verifier ownership activation path. Reject before provider creation while disabled, durably attribute every exact created instance before setup, and independently deactivate ambiguous registrations and terminate the provider on every exit. Heartbeat the real Temporal activity through bounded cleanup, wait for cancellation completion, cancel and quiesce setup/check commands cooperatively, and reserve an activity-local deadline window for bounded cleanup before the server timeout; hard worker loss and unresolved provider/DB calls retain explicit owner-TTL/orphan-reaper backstops.
