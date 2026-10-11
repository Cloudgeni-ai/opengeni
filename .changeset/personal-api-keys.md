---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Personal API keys: an organization member can create a key (`ogp_…`) that acts as them. A script or outside agent using it does what that person can do in the organization right now, capped by the key's access setting, and shows up as them, including on the organization MCP server. A changed role applies on the next request, suspension pauses the key, and leaving the organization revokes it. Keys are created in Organization settings > Developer with a choice of access and an expiry of 30, 90 (the default) or 365 days, or never; the key is shown once. People see and revoke their own keys; owners and admins see and revoke everyone's. Only the person, or an agent or key with their full access, can create one, so a limited key never mints a broader one. New routes `GET|POST /v1/organizations/:id/personal-api-keys` and `DELETE …/:apiKeyId`, with SDK methods `listPersonalApiKeys`, `createPersonalApiKey` and `revokePersonalApiKey`. Migration `0722` is rolling: older API instances read a personal key as having no access.
