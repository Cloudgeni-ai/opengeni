---
"@opengeni/github": patch
"@opengeni/api-router": patch
---

A GitHub App created from Opengeni's manifest now sends its webhooks to `OPENGENI_WEBHOOK_BASE_URL` when that is set, instead of the console's address. Deployments whose console is reachable only on a private network previously got an App whose webhook GitHub couldn't reach, so GitHub event triggers never fired until the webhook URL was fixed by hand.
