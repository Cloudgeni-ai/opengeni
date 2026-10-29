---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Provider-hosted web search and OpenAI hosted image generation now cost credit on turns whose model Opengeni pays for while credit billing is active (one check point, `paidHostedToolsChargeCredits`). Such a turn gets Opengeni's billed `web_search`/`web_fetch` tools instead of hosted search whenever a search provider is configured; without one, the hosted searches each response reports (Claude's count, and now OpenAI `web_search_call` items) are charged at $10 per 1,000 plus the 5% web-search margin as a separate, idempotent web-search debit per response. Gateway-reported costs already include search and are not charged again. OpenAI hosted image generation on the deployment's own key is no longer offered on those turns; they use the priced Gateway image tool when available. On those turns web search is admitted and paid like the turn's Gateway images: the monthly plan and grants covering the turn's model pay first (so Free plan credit applies), then general credit. Turns on the user's own keys or subscriptions, free models and billing-off deployments are unchanged.
