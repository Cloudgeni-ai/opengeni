---
"@opengeni/db": minor
"@opengeni/worker-bundle": patch
---

Make model-call-fact reconciliation resumable and bounded by input pages instead
of a full-history join. Preserve existing facts and billing ledgers, persist
progress atomically, and join database work to the maintenance caller's existing
deadline and cancellation. Preserve shorter configured statement timeouts.

Apply rolling migrations 0890–0893 before starting the new worker. Direct callers
of `reconcileModelCallFacts` must continue while `truncated` is true: counts are
per-page resolved gaps, and a page can have more work with zero gaps. Maintenance
cancellation requires the `createDb` postgres.js adapter; unsupported injected
drivers fail explicitly rather than leaving detached database work running.
