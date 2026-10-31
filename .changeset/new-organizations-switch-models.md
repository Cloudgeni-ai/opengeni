---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

New organizations start with "Switch models when subscriptions run out" on: when a chat's subscriptions run out, it continues on a subscription model of the same tier from another provider instead of waiting, and never falls back to Opengeni credits. Existing organizations keep their stored value. Rolling migration 1144 changes only the value the new-organization seed writes. Switching still takes effect only where the deployment turns it on (`OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED`, off by default). Organization and workspace model-account settings now report `crossProviderFailoverAvailable`, and the settings pages hide the switch and its fallback order while the deployment doesn't switch models, instead of showing a setting that does nothing.
