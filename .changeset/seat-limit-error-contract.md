---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Preserve the seat_limit_reached error and bounded upgrade action through the public API error envelope and SDK.

Allow optional legacyStripePriceIds in subscription catalogs so existing subscriptions keep synchronizing after current Stripe prices change. New purchases still use only the current price.
