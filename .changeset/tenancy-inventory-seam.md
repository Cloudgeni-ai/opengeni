---
"@opengeni/db": minor
---

Read-only organization tenancy inventory (migration 0285, rolling): `bun run db:inventory-tenancy --organization-id <uuid>` reports content-free counts of every legacy-attribution population the tenancy backfill/parity program gates on - ownerless sessions, unclassified variable sets/rigs/machines, connections per authority lane, membership anchors, unattributed workspace writers, and the linked-input document/Codex gates. Integers only; the SECURITY DEFINER seam validates the exact organization context and returns no identities, keys, or values.
