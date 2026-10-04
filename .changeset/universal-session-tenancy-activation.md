---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/core": patch
---

Every organization is now session-tenancy activated (maintenance migration 0611): private ("Only me") sessions, visibility changes, forks, and personal-resource grants no longer require a per-organization activation receipt, and shared-workspace Only me remains gated only by the organization's owner/admin setting. `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` and `Settings.organizationTenancyCanonicalActivationEnabled` are retired (the variable is accepted and ignored with a warning), the runtime posture no longer has an activation startup interlock, and the `db:activate-session-tenancy` operator command is removed.
