---
"@opengeni/db": patch
---

Renew sandbox agent links in one locked SQL statement instead of separate row, clock and update queries. Preserve the database-clock lease, refusal precedence and longer heartbeat extensions while removing two database round trips per successful renewal.
