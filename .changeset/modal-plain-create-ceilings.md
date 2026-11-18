---
"@opengeni/runtime": patch
---

Every Modal box now starts with its CPU and memory ceilings. A cold start without a durable admission callback (the desktop viewer, Channel A, rematerialization and rig verification) used the pinned Agents adapter's create, which sent only the reservation (0.125 cores, 128 MiB), no ceilings or egress allowlists, and skipped the create boundary that refuses a box without ceilings. It now takes Opengeni's bounded create, so these boxes get the tier's ceilings (2 cores / 4096 MiB unpaid, 16 cores / 32768 MiB otherwise) and fail closed when they are missing.
