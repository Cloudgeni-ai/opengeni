---
"@opengeni/db": patch
---

Read managed human workspace grants, organization names and the legacy default workspace together instead of issuing serial queries for each organization. Every request still resolves live memberships and permissions; provisioning, default selection and personal-workspace access are unchanged.
