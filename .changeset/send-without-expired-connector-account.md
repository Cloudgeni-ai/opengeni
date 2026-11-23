---
"@opengeni/core": patch
"@opengeni/react": patch
---

A message is no longer refused when one of its connector accounts stopped working after the chat was opened (for example its sign-in expired). It is sent without that account, the connector shows as needing reconnecting for that turn, and no other account is used in its place. A chat left open re-reads its accounts when you return to it, and reconnect notices name the service (Atlassian, not "Mcp").
