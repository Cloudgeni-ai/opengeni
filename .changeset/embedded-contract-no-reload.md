---
"@opengeni/react": minor
"@opengeni/sdk": patch
---

`OpenGeniProvider` no longer blocks or reloads the page when the server's API
contract revision differs from the bundle's; that stale-tab protection is now
the opt-in `reloadOnApiContractChange` prop used by the stock OpenGeni console,
so an OpenGeni deploy never reloads an embedding product's page. The session
proxy reports its own SDK contract revision in `/v1/config/client` and never
forwards the upstream `x-opengeni-api-contract` header to the browser.
