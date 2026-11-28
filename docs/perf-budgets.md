# Database performance budgets

`packages/db/test/perf-budgets-postgres.test.ts` guards the hot database
routines and queries that the GK speed rounds fixed. It runs on real
PostgreSQL in normal PR CI and in Batch CI, and it fails when a change makes
one of them do materially more work on the same data. It exists because
#8168's migration 1567 made every scheduled-run admission read every turn of
its chat (10.2M buffers and 3.5 s per call in production, and a daily 08:00
CPU burst) and nothing in CI noticed.

## What it measures

One production-shaped, multi-tenant fixture is seeded once per run with
set-based inserts: a chat with thousands of scheduled turns beside thousands of
short sessions; a schedule-heavy workspace with many tasks, runs and target
chats; a large credit ledger and many plan organizations; many sandbox leases
with checkpoints, a lost box with tens of thousands of requests, retained
processes and background commands; a full host export outbox; many goals; and
another tenant's sessions beside a reader workspace.

Each routine then runs as production runs it: the restricted runtime role
(`opengeni_app`) under FORCE RLS in the RLS scope its caller uses, with
SECURITY DEFINER bodies owned by a BYPASSRLS migration owner (production's
owner posture). The measurement is a deterministic work counter, never time:

| Unit         | What is counted                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `buffers`    | Shared buffers (hit + read) of `EXPLAIN (ANALYZE, BUFFERS)` on the outer statement, which includes every statement a routine runs |
| `calls`      | Function calls the statement makes (`pg_stat_get_xact_function_calls`), for policies that must not call owner-only definers       |
| `statements` | Database statements one application call sends, for batched reads that must not become one read per row                          |

PL/pgSQL routines are measured on a fresh connection's 2nd to 6th calls, so a
routine that plans again on every call is measured with that cost.
Parameterized application queries are measured as prepared statements under
both forced generic and forced custom plans, and the larger counts.

The budgets, the change each one guards, and the value measured when it was
set live in one table: `packages/db/test/perf-budgets.ts`. A budget is twice
the value measured at the commit that set it (the larger of the CI image,
PostgreSQL 16, and PostgreSQL 17), rounded up, with at least 25 buffers (or 5
calls or statements) of margin for small values. That passes ordinary drift
(index page splits, minor version planner changes) and fails a change of plan
shape, which is what regressions look like: the ones below cost 84 to 370
times their head buffers (the lookup split about 2,600 times), and the policy
regression makes thousands of definer calls where head makes none.

## The regressions it is proven against

The last tests in the file put known regressions back as the migration owner,
require the guarding budget to fail on them, and restore the current shape:

- #8168's admission body (1695 reverted to 1567's turn reads);
- `free_plan_credit_eligible` without index 1579;
- the `sessions` row policies without #8214's inline owner test;
- the lost-provider session lookup without #8243's split of its owner arms
  (dropping index 1696 alone is measured and reported, not required: here the
  planner serves the same predicate from another partial index, while
  production's statistics chose the scoped id index).

If a later migration reshapes one of these routines so its old shape no longer
applies (the proof fails on its own drift check), move the proof to the new
pre-fix shape or delete it in the same change.

## When it fails

The failure names the budget, the routine, the measured value, the budget, the
value when the budget was set, the fixture and the change it guards. First
decide whether the extra work is a regression. Usually it is: a new join, a
lost index probe, a statement that now plans on every call, a row policy that
now calls a function per row, or a batch that became one read per row. Fix the
routine. `EXPLAIN (ANALYZE, BUFFERS)` of the named statement on the fixture
shows where the buffers go.

## Updating a budget deliberately

Only raise a budget when the extra work is intended (for example a routine that
now checks something it must) and bounded by the call rather than by the
tenant's history.

1. Measure every probe without failing:

   ```bash
   OPENGENI_PERF_BUDGETS_REPORT=1 OPENGENI_REQUIRE_REAL_DB=1 \
     bun test packages/db/test/perf-budgets-postgres.test.ts
   ```

   `perf-budget-summary` prints every measurement and its budget.

2. In `packages/db/test/perf-budgets.ts`, set `measured` to the new value and
   `budget` by the rule above, and say in the comment what changed and why.
3. State the old and new numbers in the PR description, so a reviewer sees the
   increase.

Lower a budget the same way when a change makes a routine cheaper, so the next
regression is caught from the new baseline.

## Adding a budget

When a change fixes a hot routine or query, add its probe to the same file:
seed its production shape into the shared fixture (set-based, a few thousand
rows of the dimension that made it slow), add an entry to `PERF_BUDGETS` naming
the PR, add a probe that measures it as production calls it, and, where the old
shape can be put back, a regression test that shows the budget fails on it.
Keep the file fast: it seeds once, and its whole run (migration included) is
about a minute.
