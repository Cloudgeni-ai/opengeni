---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Connecting an integration from the catalog now finishes on the server. `OAuthStartRequest` takes an optional `capabilityId`; when the provider sign-in (MCP OAuth or Nango connect) completes, the callback turns that capability on with the new account as the person who started it, with the same permission rules as enabling it, and reports `capability=enabled|on` on the return. Closing the browser tab, or a desktop hand-back the browser blocks, no longer leaves the connection saved but unused. The console's return handling only shows the result and never re-enables something already on, so members are no longer refused when the capability was turned on meanwhile.
