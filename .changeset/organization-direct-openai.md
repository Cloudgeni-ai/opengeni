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

Organization owners and admins can now connect OpenAI and Azure OpenAI once for the whole organization in Organization settings → Models, next to the other organization providers. OpenAI stores an encrypted API key; Azure OpenAI stores an encrypted key plus the Azure resource endpoint. Admins add the organization's OpenAI model IDs or Azure deployments as its models, and each is checked with the organization's key (and Azure endpoint) before it is saved. The models (`organization-openai/<model>` and `organization-azure-openai/<deployment>`) inherit into the organization's current and future shared workspaces (Personal workspaces stay local), work for sessions created through the web app and the public API, and are billed to the organization's own provider account with no Opengeni credits. `OrganizationModelProviderKind` and `ModelConnectionAccessKind` gain `openai` and `azure_openai`; organization provider connection requests and responses gain an optional `endpoint` (Azure only). A missing or revoked connection fails closed and never falls back to deployment credentials. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `organization-openai` or `organization-azure-openai` provider ids. Rolling migration `0898_organization_direct_openai_model_providers.sql` widens the provider-kind, lifecycle-fact and analytics allow-lists and adds the nullable endpoint columns.

An organization ElevenLabs key no longer counts as an OpenRouter access policy when a workspace's model restrictions are read.
