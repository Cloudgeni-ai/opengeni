---
"@opengeni/core": patch
---

An MCP event source whose provider's sign-in service is temporarily down no longer tells people to reconnect. A refresh that fails while the connection stays active is retried like any outage and, if it lasts, reported as the service not answering. A rejected or revoked sign-in still asks to reconnect.
