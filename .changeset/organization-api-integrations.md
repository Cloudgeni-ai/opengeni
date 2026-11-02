---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/react": minor
---

Organizations can add an API integration once and choose where it works, the same way as an organization connector. An organization owner or admin checks an OpenAPI or GraphQL address, picks how turns sign in to it (each person with their own key or token, one organization key, or none) and which workspaces it reaches. The reviewed definition is stored with it, so every workspace it reaches runs exactly what the admin checked, and a change at the source needs a new check. In those workspaces it works like the workspace's own API integration and is listed under Custom APIs as **From your organization**. A workspace's own setup of the same API wins. A workspace manager turns it off there and back on, and a member adds their own key or token where it asks for one. New: `POST /v1/organizations/:organizationId/connectors/api-integrations/preview` (the SDK's `previewOrganizationApiIntegration`), `apiIntegration` and `apiKey` on `POST /v1/organizations/:organizationId/connectors`, `apiKey` on its `PATCH`, `kind` and `apiIntegration` on each organization connector, and `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/organization` (the SDK's `setOrganizationApiIntegrationHere`) to turn one off or on in a workspace. `ApiIntegrationInstallationSummary.organizationConnector` says when an installation comes from the organization. Migrations `1199_organization_api_integrations.sql` and `1200_validate_organization_connector_kind.sql` add `organization_connectors.kind` and validate its check.
