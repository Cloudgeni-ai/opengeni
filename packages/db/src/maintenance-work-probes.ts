import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/**
 * Read-only checks a maintenance cadence evaluates before starting a
 * dispatcher workflow. Each is a superset of its dispatcher's claim predicate:
 * `false` proves the claim would find nothing, `true` only says it may. They
 * take no locks and write nothing, so an idle deployment's tick is one indexed
 * read instead of a workflow execution.
 */
async function probe(db: Database, query: ReturnType<typeof sql>): Promise<boolean> {
  const [row] = await rawRows<{ due: boolean | null }>(db, query);
  return row?.due === true;
}

/** A committed workflow wake revision is due for delivery. */
export async function sessionWorkflowWakesDue(db: Database): Promise<boolean> {
  return await probe(db, sql`select opengeni_private.session_workflow_wakes_due_v1() as due`);
}

/** An automatic-title event still awaits its live fanout. */
export async function automaticSessionTitleFanoutDue(db: Database): Promise<boolean> {
  return await probe(
    db,
    sql`select opengeni_private.automatic_session_title_fanout_due_v1() as due`,
  );
}

/** A workspace pause timer has reached its due time. */
export async function workspacePauseTimerDue(db: Database): Promise<boolean> {
  const rows = await rawRows<{ workspace_id: string }>(
    db,
    sql`select workspace_id from opengeni_private.list_due_workspace_pause_timers(1)`,
  );
  return rows.length > 0;
}

/** A Knowledge index job could be leased for this embedding model. */
export async function knowledgeIndexDue(
  db: Database,
  input: { model: string; dimensions: number },
): Promise<boolean> {
  return await probe(
    db,
    sql`select opengeni_private.knowledge_index_due_v1(${input.model}, ${input.dimensions}) as due`,
  );
}

/** A maintained site-auth connection is due and outside a live claim. */
export async function siteAuthMaintenanceDue(
  db: Database,
  input: { claimTimeoutMs: number },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.claimTimeoutMs) || input.claimTimeoutMs < 0) {
    throw new Error("site auth maintenance claim timeout must be a non-negative safe integer");
  }
  return await probe(
    db,
    sql`select opengeni_private.site_auth_maintenance_due_v1(${input.claimTimeoutMs}) as due`,
  );
}
