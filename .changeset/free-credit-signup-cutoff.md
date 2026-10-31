---
"@opengeni/db": patch
---

Add an owner-only Free credit signup cutoff (rolling migration 1119). `opengeni_private.set_free_credit_signup_cutoff(not_before, operator, reason, expected_revision)` writes an audited, revision-fenced setting; while it is set, new Free monthly periods go only to organizations whose signup-receipt owner was created at or after the cutoff. No cutoff (the default) changes nothing, and issued periods stay untouched and spendable. `scripts/operator/promotion-decisions.ts` gains `--free-credit-cutoff <timestamp|none>` and `--free-credit-cutoff-history`.
