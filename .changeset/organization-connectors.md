---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Organizations can add a connector once and choose where it works. An organization owner or admin adds a catalog connector or a custom remote MCP server with how turns sign in to it (each person with their own account, an organization key, or none) and which workspaces it reaches: every shared workspace or chosen ones, with a separate switch for members' Personal workspaces. In those workspaces it works like an enabled connector of the workspace's own, listed once as **From your organization** (`lifecycle.managedBy: "organization"`, `metadata.organizationConnector`), with the same server ID a workspace setup would give. The workspace's own setup of the same connector, on or off, wins: a workspace manager turns it off there with the ordinary disable action and back on with an empty enable, while a member's personal setup never replaces it. New: `GET`/`POST /v1/organizations/:organizationId/connectors` and `PATCH`/`DELETE .../connectors/:connectorId`, the SDK's `listOrganizationConnectors`, `createOrganizationConnector`, `updateOrganizationConnector` and `deleteOrganizationConnector`, and migration `1175_organization_connectors.sql`. Only signed-in organization owners and admins (and agents acting for one) manage them; organization API keys are refused.
