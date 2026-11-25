import { sql } from "drizzle-orm";
import { withDatabaseStatementTimeout, type Database } from "./database";

export type AutomationRunCount = { trigger_kind: string; outcome: string; runs: string };

function rows<T>(result: T[] | { rows: T[] }): T[] {
  return Array.isArray(result) ? result : result.rows;
}

/** Pending receipts and their folded totals share one MVCC snapshot. */
export async function readAutomationRunCounts(db: Database): Promise<AutomationRunCount[]> {
  return rows<AutomationRunCount>(
    await withDatabaseStatementTimeout(db, 1_000, (bounded) =>
      bounded.execute<AutomationRunCount>(sql`
        select trigger_kind, outcome, sum(runs)::text as runs from (
          select trigger_kind, outcome, runs from automation_run_counters
          union all
          select trigger_kind, outcome, runs from automation_run_outcome_events
        ) counts group by trigger_kind, outcome`),
    ),
  );
}

export async function automationRunCounterCompactionDue(db: Database): Promise<boolean> {
  const [result] = rows<{ due: boolean }>(
    await db.execute(
      sql`select exists(select 1 from automation_run_outcome_events offset 499) as due`,
    ),
  );
  return result?.due ?? false;
}

/** One bounded maintenance batch; no producer transaction takes this lock. */
export async function compactAutomationRunCounters(db: Database): Promise<void> {
  await withDatabaseStatementTimeout(db, 5_000, async (bounded) => {
    // Different control workers may tick together. Serialize only the folders,
    // not inserts or scrapes. A rollback keeps all pending receipts in place.
    const [lock] = rows<{ acquired: boolean }>(
      await bounded.execute(
        sql`select pg_try_advisory_xact_lock(hashtextextended('opengeni:automation-run-counter-fold', 0)) as acquired`,
      ),
    );
    if (!lock?.acquired) return;
    await bounded.execute(sql`
      with batch as materialized (
        select ctid from automation_run_outcome_events limit 20000
      ), removed as (
        delete from automation_run_outcome_events e using batch b where e.ctid=b.ctid
        returning e.trigger_kind,e.outcome,e.runs
      )
      insert into automation_run_counters as totals (trigger_kind,outcome,runs)
        select trigger_kind,outcome,sum(runs)::bigint from removed group by trigger_kind,outcome
      on conflict (trigger_kind,outcome) do update set runs=totals.runs+excluded.runs`);
  });
}
