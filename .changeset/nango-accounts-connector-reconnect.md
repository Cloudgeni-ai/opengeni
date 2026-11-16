---
"@opengeni/contracts": patch
"@opengeni/connect": patch
"@opengeni/api-router": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Accounts held by Nango are listed by `GET /connect/accounts` with `backend: "nango"`, and the chat and Settings never start a native reconnect for them; a chat Reconnect opens the connector's own Connect instead. A workspace-shared Nango Google account reads as connected.
