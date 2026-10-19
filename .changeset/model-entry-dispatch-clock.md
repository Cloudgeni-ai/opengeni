---
"@opengeni/worker-bundle": patch
---

Start pre-dispatch timing only at SDK model entry. Native-provider transport admission rechecks after dispatch no longer count the previous response and tool work as preparation for the next call. Authorization checks, provider requests, and existing persisted measurements are unchanged.
