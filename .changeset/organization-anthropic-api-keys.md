---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/worker-bundle": minor
---

An organization's Anthropic API connection can hold several API keys, for example one per Anthropic organization whose credits it uses. The connection's own key stays the first, so an organization with one key works exactly as before, and model ids stay `organization-anthropic/…`. Admins add, rename and remove keys under Models on the Anthropic API page; each new key is checked with Anthropic's free model listing first, stored encrypted and never shown again.

Each chat keeps one key, so its prompt cache stays warm, and moves to another key only when Anthropic refuses its key for lack of credits. A refused key is marked **Out of credits** and left out until an admin chooses **Serve again**; when every key is out of credits, the request fails without being sent. Rate limits keep their usual handling. Claude subscription models never use these keys, and nothing buys credits or enables top-ups.

New routes under `/v1/organizations/:organizationId/model-providers/anthropic/api-keys`; the SDK calls them with `listOrganizationAnthropicApiKeys`, `addOrganizationAnthropicApiKey`, `updateOrganizationAnthropicApiKey`, `removeOrganizationAnthropicApiKey` and `serveOrganizationAnthropicApiKeyAgain`.
