---
"@opengeni/db": patch
---

The Console sessions list loads again for organizations with many sessions: each page's per-session cost is now one lookup by the credit ledger's idempotency index instead of a full ledger scan per session, which exceeded the Console's 20 s query limit. Spend per organization key also reads the ledger once instead of once per managed workspace. Totals are unchanged.
