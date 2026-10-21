---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": patch
---

Session list totals now report an optional `waiting` count of idle sessions parked until they are woken by input or a timer. These sessions remain included in `active` for compatibility. The web console uses the count to show a still clock instead of the working spinner for sessions that are only waiting.
