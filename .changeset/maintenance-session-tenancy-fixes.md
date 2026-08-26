---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Repair realtime human-authority routing and metrics, personal Document reads
under FORCE RLS, private-session visibility transition checks, and
tenant-scoped session-tenancy fencing through migrations 0343-0345.

Migration 0345 is a one-way maintenance cutover. Stop and drain every API,
control worker, and turn worker before applying it, then start only binaries
built for schema ordinal 0345 or newer. Never restart a pre-0345 image after
the migration commits: its session-tenancy writes do not enter the required
workspace fence and will fail closed.