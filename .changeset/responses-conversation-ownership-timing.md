---
"@opengeni/network": patch
"@opengeni/codex": patch
"@opengeni/worker-bundle": patch
---

Reserve persistent Responses sockets for explicitly scoped conversation requests so title side requests cannot displace a warmed main connection or continuation chain. Add immutable request-receipt snapshots of local dispatch/socket timing and allowlisted response-scoped server timing, without changing model request content, prewarming, retries, or custody.
