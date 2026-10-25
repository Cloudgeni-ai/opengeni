---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

Allow the built-in Azure OpenAI provider to use an Entra app registration through
`OPENGENI_AZURE_OPENAI_AUTH_MODE=deployment_identity`, reusing the existing
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` settings and token
helper. Preserve early token refresh, bearer-only requests, reasoning effort and
allowed models, and invalidate cached clients when the configured secret changes.
