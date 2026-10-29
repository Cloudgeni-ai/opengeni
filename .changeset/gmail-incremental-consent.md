---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/connect": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
"@opengeni/db": patch
---

Connecting Gmail now asks Google only to read mail. When an agent later needs to draft, send or organize mail, the chat shows "Give Gmail more access" with an Allow button, which reconnects the same account and asks only for the missing permission; everything already allowed stays. Every Gmail tool stays in the agent's tool list; a tool the account cannot use yet stops before anything runs and before any approval card. Accounts connected earlier keep their access.

Connect begin requests accept an optional `requestedScopes` list for a reconnect (`reconnectAccountId` is required with it), and OAuth provider profiles can declare `incrementalScopes` that are asked for only when requested or already granted. The connection token resolver now returns `grantedScopes` for every OAuth credential.
