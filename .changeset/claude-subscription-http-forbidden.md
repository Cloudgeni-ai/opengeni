---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/subscriptions": patch
---

Keep Claude subscriptions out of automatic rotation after a model request is denied with HTTP 403. The account shows why it was skipped and returns to service after reconnecting. Model suspensions and stream errors do not quarantine the account.
