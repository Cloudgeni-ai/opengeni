---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Protect standalone rig-verification sandboxes with durable, expiring exact-instance ownership before setup begins. Modal orphan sweeps now consume one live-instance projection for leases and bounded verifiers, while verifier cleanup independently deactivates ownership and terminates the provider on every exit path.