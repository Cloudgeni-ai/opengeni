---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Add organization-owned integration acquisition policy with a discoverable catalog,
revisioned administration API and SDK, and organization settings. Enforce selected
provider and custom-protocol permissions on supported setup and installation paths
at preparation and persistence boundaries.

Preserve ordinary ownership and authorization, exact completed-request replay,
unchanged reconciliation, cancellation and other reducing operations. Existing
connection execution and credential refresh are not revoked by this policy.
Deployment-configured tools and embedding-host session-local MCP configuration
retain their existing admission rules; this is not a network or execution allowlist.

Apply the organization integration policy migration and matching role provisioning
with the matching runtime before enabling the setting. Older runtimes do not enforce
the new acquisition policy. See `docs/organization-integration-policy.md` for the
administration, identity, persistence and recovery contract.