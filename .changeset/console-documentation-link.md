---
"@opengeni/contracts": minor
"@opengeni/sdk": patch
"@opengeni/config": patch
---

Advertise the product documentation the web console links from its Help menu.
`ClientConfig` gains an optional `documentationUrl` field (an absolute http(s)
URL, or `null` when the deployment hides the link) served by
`/v1/config/client`, and `@opengeni/contracts` exports
`DEFAULT_OPENGENI_DOCUMENTATION_URL`. Operators set it with the new
`OPENGENI_DOCUMENTATION_URL` setting: unset means `https://docs.opengeni.ai`,
`none` hides the link, and any other value fails startup. An absent
field means a server that predates it, so clients show no link.
