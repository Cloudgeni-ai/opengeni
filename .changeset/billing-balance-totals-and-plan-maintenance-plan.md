---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Credit balance reads no longer sum the whole credit ledger: a per-account totals table (`credit_ledger_account_totals`), kept exact by statement-level ledger triggers, holds each account's balance and API spend, and both the balance read and the `credit_balance_by_account` metric use it. The migration installs the triggers without reading the ledger and an online batched backfill completes one account per transaction; until an account is complete, reads recount its ledger. The runtime role can read but not write the totals, a ledger TRUNCATE clears them, and the worker samples accounts each metrics cycle and reports any totals that differ from a recount (`opengeni_credit_ledger_totals_mismatched_accounts`). The subscription plan maintenance inventory reads the same accounts with a cheaper plan, helped by a partial index on verified signup trial grants.
