---
"@opengeni/config": patch
"@opengeni/api-router": patch
---

MCP OAuth always sends providers the short reference `state`, so connecting Stripe and other providers that cap `state` length works on every deployment. `OPENGENI_INTEGRATIONS_OAUTH_SHORT_STATE_ENABLED` is retired: it is ignored with a one-time startup warning and can be removed from deployment configuration.
