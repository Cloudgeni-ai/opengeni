---
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Skip the redundant in-box rig marker probe when a live Modal session reports
the exact immutable image that already passed the rig's content, source,
provider-binding, and independent cold-boot verification. Missing or mismatched
image identity retains the existing fail-closed marker and setup path.
