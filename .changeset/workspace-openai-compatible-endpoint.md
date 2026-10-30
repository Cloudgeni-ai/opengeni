---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/react": minor
"@opengeni/runtime": minor
"@opengeni/db": patch
---

A workspace can connect its own OpenAI-compatible model API: Settings → Models → "Connect an OpenAI-compatible endpoint" asks for an HTTPS base URL, an API key, a model ID, the API format (Chat Completions or Responses) and an optional name. The model then appears in that workspace's picker like any other direct model, billed to the workspace's own key, which never leaves that workspace. The same works through `POST /connections` with `metadata.credentialRole: "direct_openai_compatible"` and `metadata.directModelProvider: { provider: "openai_compatible", baseUrl, model, api?, label? }`.

Only public HTTPS hosts are accepted, and every request resolves the host once and refuses private addresses and redirects. These endpoints report an unknown data location, so residency policies that require a known region leave them out. A model check that cannot reach any direct provider now answers 422 with the reason instead of a generic "temporarily unavailable".
