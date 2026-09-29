---
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
---

`api_key` Connections now must store `{ headers: {...} }` or `{ placements: [...] }`; create and update reject any other shape (such as a bare `{ apiKey }`) with 422 instead of accepting it and failing every tool call later. The SDK types this as `ApiKeyConnectionCredential`. `previewApiIntegration` warns when the selected Connection does not place its credential where the API description declares, and a call through an unusable stored credential now names the repair instead of "needs a connected account".
