---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Stateless model calls are admitted as before #7241 again: admission reads the spendable balance and never reserves an estimated cost, and requests without `max_tokens` are no longer given a default output limit. Parallel admitted calls may overshoot together, as documented in `docs/usage-allowances.md` and `docs/session-usage-limits.md`. The `model_call_credit_holds` table is left in place, unused, and is dropped in a later contraction migration.
