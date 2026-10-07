---
"@opengeni/subscriptions": patch
---

Add provider-neutral inference-source modes for automatic, workspace-only, and
organization-only account selection. Keep workspace and organization source
membership and authorization policy separate on a canonical shared connection,
while retaining the legacy `useOrganizationAccounts` setting as a compatible
projection.
