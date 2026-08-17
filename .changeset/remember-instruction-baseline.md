---
"@opengeni/core": patch
"@opengeni/db": patch
---

`remember` with `lane: instruction_policy` now binds the draft to the target's current activation baseline (active head revision and CAS version, including a deactivated-to-null boundary) instead of assuming an empty workspace, so a user-directed rule can be proposed and confirmed in a workspace that already has an active policy.
