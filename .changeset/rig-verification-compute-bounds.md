---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Rig verification now takes a sandbox only within the organization's plan and fleet compute limits: an organization whose tier allows no running box (held or denied) is refused before a verification sandbox starts, and the verification records a failed outcome instead of retrying. Creating a sandbox environment, change or version is refused with 403 for a suspended organization. `acquireLease` now requires `sandboxPlanLimits`; a caller that must bypass the limits passes the named opt-out `"unbounded_test_fixture"`.
