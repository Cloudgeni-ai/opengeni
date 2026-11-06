---
"@opengeni/core": patch
"@opengeni/db": patch
---

An MCP event source whose provider's sign-in service is temporarily down no longer tells people to reconnect. The token resolver now reports a refresh that failed for a passing reason (token endpoint unreachable, 5xx, 408 or 429) through a new `onTransientRefreshFailure` option, and such a failure is retried like any outage and, if it lasts, reported as the service not answering. A rejected grant, or an access token the provider refuses when there is nothing to refresh it with, still asks to reconnect.
