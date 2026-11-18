---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

Every Modal box now starts with its CPU and memory ceilings. A cold start without a durable admission callback (the desktop viewer, Channel A, rematerialization and rig verification) used the pinned Agents adapter's create, which sent only the reservation (0.125 cores, 128 MiB), no ceilings or egress allowlists, and skipped the create boundary that refuses a box without ceilings. It now takes Opengeni's bounded create, so these boxes get the tier's ceilings (2 cores / 4096 MiB unpaid, 16 cores / 32768 MiB otherwise) and fail closed when they are missing.

A box of an organization that review holds or denies is now stopped in the next reaper sweep. The closed-organization drain runs in every sweep's inventory instead of only in the maintenance pass after it, skips the reconnect grace, and also closes an unpaid organization whose self-serve owner or a viewer runs a held or denied one. Before, a denial took a maintenance pass, the 60 second grace and another sweep before the box was stopped.
