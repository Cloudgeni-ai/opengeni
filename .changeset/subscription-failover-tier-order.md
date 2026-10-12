---
"@opengeni/subscriptions": patch
---

The subscription placement policy can derive a default cross-provider fallback order from model tiers. A model may declare an optional tier (`frontier`, `standard` or `fast`), and provider adapters gain an optional `modelTier` member. When the settings name no fallback entry for the preferred model and cross-provider failover is on, the candidates are the models of other providers with the same tier, never a higher or a lower one; an explicit entry, including an empty list, still wins, and the new `hasFallbackOrderEntry` tells a missing entry from an empty one. Nothing changes today: no adapter declares a tier yet, and the core's placement keeps cross-provider failover off.
