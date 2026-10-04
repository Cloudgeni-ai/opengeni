---
"@opengeni/sdk": patch
---

`new OpenGeni({ baseUrl })` treats a blank value (a copied `.env.example` line like
`OPENGENI_API_BASE_URL=`) as unset and uses the hosted API, and a blank
`organizationId` as unset. `@opengeni/sdk/package.json` is now an exported subpath.
