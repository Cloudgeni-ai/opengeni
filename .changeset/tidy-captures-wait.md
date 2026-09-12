---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Bound sandbox acquisition and workspace mutation waits across repeated archive capture attempts. Honor the first observed capture's persisted timeout once, without letting expired or renewed claims replenish the caller's deadline; retain all capture and writer fences.

Release an exact unpublished drain capture after its provider promise rejects, including after a local timeout, so waiting turns can resume the intact live sandbox. Unresolved captures, published archives, successors, and provider teardown remain fenced.

Fresh claims allocate a new provider request identity; uninterrupted replacements retain it, preventing stale snapshot replay after an intervening writer re-arms the lease.
