---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/sdk": minor
---

Add an opt-in browser analytics runtime contract with consent-gated, allowlisted
Reo, PostHog, and GA4 provider configuration. Self-hosted deployments remain
disabled by default, and public client configuration exposes no provider
administrative credentials. Third-party modules load lazily, Reo clipboard/AI
capture is disabled, query-bearing routes are excluded, and consent can be
withdrawn without destabilizing the console.
