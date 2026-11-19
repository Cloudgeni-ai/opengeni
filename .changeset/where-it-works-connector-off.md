---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
---

"Where it works" for your own connector login now says when a shared workspace hasn't turned that connector on, even where the login itself is on, so "on" no longer reads as usable there. Each workspace row of the own-resource reach and own-resources responses carries a new optional `connectorOff` flag for this. On the current workspace's row, the connector page offers "Use it here", the same step as its Connect button, which uses your existing login without a new sign-in. My things says the same, links that row to the connector's page, and no longer counts such a workspace as one where the login works.
