---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
"@opengeni/worker-bundle": patch
---

An expired connector account is no longer invisible. When a refresh token is rejected and a connection moves to `needs_reauth`, the turn that hit it posts one inbox notice to the person who started that turn ("Gmail needs reconnecting", naming the account), deduplicated per connection. The turn notice for unavailable connectors now lists the accounts that need reconnecting with the day they stopped working, and `capability_catalog_search` says the same in the item's setup text and a new `setup.reconnect` list. `capability_authorization_request` takes an optional `connectionId` (picked automatically when exactly one account can be reconnected) and posts a card that reconnects that same account, instead of a fresh Connect card that could not finish because the account was already connected. The web and native cards show "Reconnect <service>" and skip the ownership choice.
