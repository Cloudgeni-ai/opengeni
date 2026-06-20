# INTEGRATION SPEC — SUPERSEDED

> **⚠️ This file is SUPERSEDED.** It was the pre-reconciliation integration artifact — the old 20-conflict ledger (CR1–CR20) plus the owner-actor end-to-end flows. Its model has been replaced. Do not build from it.

**Where the current truth lives:**

- **Canonical shared interfaces** — the capability set + descriptor, the `SessionCapabilities` handshake, the event taxonomy, the scoped token, and the permissions — are defined **once** in **`00-master-spine.md` §C** (C.1 / C.2 / C.3). The spine wins on every disagreement.
- **Owner model is stateless** — there is no in-worker owner actor. Any pool worker resumes the box by id from the group lease per turn, injects it non-owned, runs, and drops the handle at turn end. See **`modules/02-owner.md`**.
- **Concurrency is unlimited** — sessions sharing a box run turns concurrently with no serialization or mutex; conflicts are last-writer / OS-implicit. Sandboxes are shared, keyed by `sandbox_group_id`. See **`05-addendum-shared-sandboxes.md`**.
- **The lease is authoritative** in **`00-master-spine.md` §C.2** / **`modules/01-lease.md`** (singleton UNIQUE + refcount + `cold→warming` CAS + `lease_epoch` fence + holders). Liveness = lease refcount; the box rides the provider's existing idle-timeout between uses and the stateless reaper terminates at refcount 0.

**What in the original is now dead** (do not resurrect): the in-worker `SandboxOwner` actor and its `Map<sessionId, SandboxOwner>`; the per-session `sandbox-owner::<sessionId>` Temporal task queue and per-session `Worker.create`; the `owner_worker_id` / `owner_task_queue` lease columns; the `ownerHeartbeat` warm-meter activity (warm-time now accrues on the turn heartbeat + the stateless reaper sweep); the "all four flows funnel through the single `SandboxOwner` actor" narrative; and **CR6** (the per-session-worker / cold-spawn co-location resolution). The rest of the old conflict ledger and the old DDL have been folded into and corrected by the spine §C and the module specs.
