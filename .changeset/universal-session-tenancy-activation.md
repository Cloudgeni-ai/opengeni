---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/core": patch
---

Every organization is now session-tenancy activated (rolling migration 0611): private ("Only me") sessions, visibility changes, forks, and personal-resource grants no longer require a per-organization activation receipt, and the owner/admin Only-me setting defaults to enabled when an organization has never changed it (owners and admins can still turn it off). `OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED` and `Settings.organizationTenancyCanonicalActivationEnabled` are retired (the variable is accepted and ignored with a warning), the runtime posture no longer has an activation startup interlock, and the `db:activate-session-tenancy` operator command is removed.
