---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Report a crashed browser tab as a definite, non-retryable `tab_crashed` diagnosis with open-a-new-tab guidance through browserd and the API. Previously the API turned it into a generic "temporarily unavailable, retry" outage, so agents kept retrying a dead tab.
