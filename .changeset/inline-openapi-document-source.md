---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

`previewApiIntegration` and `installApiIntegration` accept an inline OpenAPI document: `source: { kind: "openapi_document", sourceKey, document, baseUrl? }` (JSON or YAML, at most 8 MiB). `sourceKey` is the stable installation identity, server URLs must be absolute (or `baseUrl` given), and the preview echoes only the document's SHA-256. Calls still follow the deployment network policy, so a product on a private or loopback address still needs a public tunnel unless the operator enables private targets.
