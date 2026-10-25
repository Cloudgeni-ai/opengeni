---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

New optional `OPENGENI_WEBHOOK_BASE_URL`: the public address other services send webhooks to, when it is not `OPENGENI_PUBLIC_BASE_URL`. Event source webhook URLs, the GitHub App's webhook URL and MCP Events callback URLs use it, so a deployment whose console is reachable only on a private network can publish just the signed webhook paths at another address. Unset, everything uses `OPENGENI_PUBLIC_BASE_URL` as before.
