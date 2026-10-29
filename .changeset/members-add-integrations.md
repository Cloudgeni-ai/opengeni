---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": patch
"@opengeni/react": minor
---

Members of a shared workspace (`connections:write`) can now add integrations: install and remove plugins and API integrations, add custom MCP servers, turn on any catalog integration that is not on yet, configure integration sources, finish an agent-prepared MCP key setup, and connect a workspace-owned OAuth MCP account from the chat card. Integration admins (`capabilities:manage`) still own tool approval rules (Allow/Ask/Block), auto-approval (`autoApprovedTools`, an explicit `requireApproval` other than `true`), changing an integration that is already on, and turning one off for everyone. A member's add is create-only: it never rewrites or shadows an existing connection or turns back on one an admin turned off. The organization integration allowlist still applies, and an organization that sets `personalIntegrationSetup: "admins"` keeps turning integrations on for admins. New exports: `INTEGRATION_SETUP_PERMISSION` and `canAddIntegrations` (contracts), `requireIntegrationSetupAuthorization`, `hasIntegrationSetupPermission` and `hasIntegrationAdminPermission` (core), `canAddWorkspaceIntegrations` and `canConnectWorkspaceMcpFromChat` (react), and `CreateCapabilityCatalogItemInput.createOnly` (db).
