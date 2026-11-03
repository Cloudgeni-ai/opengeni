---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/subscriptions": patch
---

Opening a chat no longer waits for a slow subscription provider's model list. When a shared ChatGPT subscription's list is more than a minute old, the client config and model picker waited for a live refresh (token renewal plus the provider's model list, up to its 5 second timeout). They now wait at most 300 ms, then use the last list observed under the same credentials (or treat the account as unknown, never unavailable) while the refresh finishes in the background and records its result. The step now has its own trace span with its outcome.
