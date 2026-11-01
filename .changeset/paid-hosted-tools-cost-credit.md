---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Provider-hosted web search and OpenAI hosted image generation now cost credit on turns whose model Opengeni pays for while credit billing is active (one check point, `paidHostedToolsChargeCredits`). Such a turn gets Opengeni's billed `web_search`/`web_fetch` tools instead of hosted search whenever a search provider is configured. Without one, the hosted searches each response reports (Claude's count, and now OpenAI `web_search_call` items) are charged at $10 per 1,000 plus the 5% web-search margin, as a separate, idempotent web-search debit per response, including a response that reported no token usage. Gateway-reported costs already include search and are not charged again. OpenAI hosted image generation on the deployment's own key is no longer offered on those turns. They use the priced Gateway image tool, so they have no image tool unless the managed Gateway image credential or a workspace Gateway key is configured.

Paid tools on those turns are paid like other app tools: plan credit first (the Free plan's monthly credit included, whatever models its scope lists), then grants that list the turn's model, then general credit. The new tool credit usage (`toolCreditUsage`) applies to Gateway images too, so Free plan credit now pays for them on any model. These debits keep the turn's billing origin, so API work pays from credits only. Turns on the user's own keys or subscriptions, free models, billing-off deployments and legacy billing accounts (`OPENGENI_BILLING_LEGACY_ACCOUNT_IDS`, CloudGeni's host account by default) are unchanged. `OPENGENI_PAID_HOSTED_TOOLS_CREDIT_BILLING=false` (default `true`) turns the new charges off and restores free hosted search and images on every turn.
