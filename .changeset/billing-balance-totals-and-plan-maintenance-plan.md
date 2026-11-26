---
"@opengeni/db": patch
---

Credit balance reads no longer sum the whole credit ledger: a per-account totals table (`credit_ledger_account_totals`), kept exact by statement-level ledger triggers and backfilled in its migration, holds each account's balance and API spend, and both the balance read and the `credit_balance_by_account` metric use it. The subscription plan maintenance inventory reads the same accounts with a cheaper plan, helped by a partial index on verified signup trial grants.
