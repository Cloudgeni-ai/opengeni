---
"@opengeni/db": patch
---

The child-lifecycle outbox reconciler now delivers a backlog to parents in the order the rows were produced. The claim already selected pending rows oldest first, but returned them in the table's physical order, so a parent could receive sibling results out of completion order, or have an older progress notice supersede a newer one. Rolling migration 0528 returns the claimed rows sorted by `created_at`, then `id`; its signature and grants are unchanged.
