---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

An organization can connect its own OpenAI-compatible endpoints (a public HTTPS base URL, an API key and model IDs) as organization model accounts, from the same Connect provider list as its OpenAI, Azure OpenAI, OpenRouter, Opper and Vercel accounts, with the same "Available in" step, and it can connect several. Their models reach workspaces like the other organization accounts, billed by the provider with no Opengeni credits, and every request to them stays DNS-pinned to public addresses without redirects. New routes under `/v1/organizations/:id/model-providers/openai_compatible/endpoints` list, connect, re-key and disconnect endpoints and add or remove their models; the SDK adds `listOrganizationCompatibleEndpoints`, `createOrganizationCompatibleEndpoint`, `replaceOrganizationCompatibleEndpointKey`, `revokeOrganizationCompatibleEndpoint`, `createOrganizationCompatibleEndpointModel` and `deleteOrganizationCompatibleEndpointModel`, and model connection access accepts `openai_compatible`. The first sign-in model step offers it too. Workspace-only compatible connections made before keep working and stay listed on their workspace; new ones are connected for the organization.
