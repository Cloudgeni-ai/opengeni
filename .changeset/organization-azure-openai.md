---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Organization owners and admins can now connect Azure OpenAI once for the whole organization in Organization settings → Models. The connection stores an encrypted API key plus the Azure resource endpoint, and admins add the organization's Azure deployments as its models; each deployment is checked against the organization's endpoint before it is saved. The models (`organization-azure-openai/<deployment>`) inherit into the organization's current and future shared workspaces (Personal workspaces stay local), work for sessions created through the web app and the public API, and are billed to the organization's Azure account with no Opengeni credits. `OrganizationModelProviderKind` and `ModelConnectionAccessKind` gain `azure_openai`; organization provider connection requests and responses gain an optional `endpoint`. A missing or revoked connection fails closed and never falls back to deployment credentials. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `organization-azure-openai` provider id. Rolling migration `0832_organization_azure_openai_model_providers.sql` widens the provider-kind, lifecycle-fact and analytics allow-lists and adds the nullable endpoint columns.
