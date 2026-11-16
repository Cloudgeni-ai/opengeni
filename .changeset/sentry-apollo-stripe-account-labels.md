---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Sentry and Apollo connections now show the signed-in account (email or name, plus the Sentry organization when there is only one) instead of a generic "Sentry account" or "Apollo.io account", and you can connect more than one account of each. Stripe connections are recognised again with Stripe's current account answer and are labelled with the account's email and business name when it has them. When an Atlassian tool needs a site and several are available, the message the agent gets now lists each site's URL next to its name and cloud ID.
