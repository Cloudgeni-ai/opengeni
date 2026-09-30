---
"@opengeni/sdk": minor
"@opengeni/api-router": patch
---

Make the public API compatibility policy explicit and enforced
(`docs/design/api-compatibility-policy.md`). Deprecated public routes now answer
with standard `Deprecation`, `Sunset`, and `Link: rel="deprecation"` headers
(exposed through CORS), and `OpenGeniClient` reports each deprecated route once
through the new `onDeprecation` option (default: one `console.warn` per route;
`false` silences it; `parseDeprecationNotice` is exported). The API no longer
advertises its `x-opengeni-api-contract` revision to a bearer-authenticated
caller that announced a different one, so published SDKs, which reject any
other revision on every response, keep working across additive contract bumps.
