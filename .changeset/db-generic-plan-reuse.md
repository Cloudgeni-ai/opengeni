---
"@opengeni/db": patch
---

Prepared statements on direct database connections now use Postgres's default plan cache mode instead of forcing a fresh plan on every execution. Planning a short statement under row-level security often costs far more than running it; repeated statements, and the statements inside database routines and triggers, now reuse a generic plan once Postgres finds it no costlier, which cuts database CPU substantially under load.
