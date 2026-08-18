---
"@opengeni/db": minor
---

Add the tenancy backfill receipt and unresolved-row ledger (migration 0288, rolling). Phase D of the organization-tenancy program requires backfill to record receipts and unresolved rows without widening access, so both tables are FORCE RLS with no direct `opengeni_app` DML and are writable only through the `tenancy_backfill_ledger` lifecycle seam (`open_tenancy_backfill_receipt`, `record_tenancy_backfill_unresolved`, `complete_tenancy_backfill_receipt`). Receipts are idempotent per organization/resource-family/run key; unresolved evidence is append-only and its count is owned by the append path rather than supplied at completion, so a sweep cannot understate its own outstanding obligations. The unresolved-row shape deliberately carries only a resource id and a fixed reason code - it records a refusal to infer authority and has no column able to express one.
