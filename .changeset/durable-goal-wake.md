---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Persist and transactionally materialize revisioned active-goal continuation
obligations, recover their Temporal delivery without human input or model
polling, preserve authoritative human/Steer ordering, and expose truthful
scheduled, running, blocked, and invariant-broken continuation state to clients.
Make agent goal updates revisioned, attempt-recoverable commands so ambiguous
commit responses reconcile without duplicate mutation or stale overwrites.
