---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

New `connections:personal` permission: connect your own accounts and use them in your own chats without administering the workspace. It allows creating, listing and removing only the caller's own (personal) connections, signing in to one's own account through Connect, and turning a reviewed catalog OAuth integration on for personal accounts when it is not on yet (create-only, subject-scoped, no credentials or config, within the organization integration policy). It never covers custom MCP servers, shared or workspace connections, other people's connections, or disabling or reconfiguring integrations. `connections:write` includes it, so existing roles, keys and organization key policies keep their meaning, and workspace Members can now turn such an integration on for their own accounts. Once on, the integration is visible to the workspace's other members as optional; each must connect their own account.

Organizations can reserve this for admins with the new `personalIntegrationSetup` integration policy setting (`members` by default, `admins`), also in Organization settings → Integrations (migration 0974).

Embeds: per-user workspaces now get `connections:personal` by default, and the new `identities` option (`"per_user"` or `"shared"`) on the `Opengeni` facade and `createWorkspaceIdResolver` decides it for tenant workspaces: `per_user` adds signed-in tenant users with it, `shared` keeps it off everywhere. `memberPermissions` still overrides both. The shared connect card and the stock conversation's in-chat connect decision use the new `personalIntegrationSetupAccess` helper from `@opengeni/contracts/personal-integration-setup`, offering only a personal connection when that is all the person may do.
