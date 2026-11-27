---
"@opengeni/api-router": patch
---

Voice calls no longer wait for the provider's voice configuration when a recently read copy exists. A copy past its five-minute freshness window (up to a day old) is used for the call while the same call refreshes it. If the provider refuses the call because that copy changed, the call is placed once more with the refreshed configuration.
