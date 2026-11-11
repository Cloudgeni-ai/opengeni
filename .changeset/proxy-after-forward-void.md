---
"@opengeni/sdk": patch
"@opengeni/runtime": patch
---

`createSessionProxyHandler`'s `afterForward` option now accepts a record-only hook declared on its own (`async function record(route, response) { ... }`, typed `Promise<void>`) without an explicit `return undefined`. Web fetches through TinyFish now accept only a cached copy younger than ten minutes instead of one of any age.
