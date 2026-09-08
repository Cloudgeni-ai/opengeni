---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Preserve workflow wake retries until pending input is admitted, while future waits stay parked at their deadline, and expose current session waits and waiting descendant counts. Refresh wait status on live events and retain the status projection sequence so newer session reads cannot be overwritten by older events.
