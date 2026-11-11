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

/** A sandbox lease is not cold or still has a holder: the lease reaper may act. */
export async function sandboxLeaseReaperDue(db: Database): Promise<boolean> {
  return await probe(db, sql`select opengeni_private.sandbox_lease_reaper_due_v1() as due`);
}

/** A warm box may be due for an idle checkpoint at this snapshot interval. */
export async function sandboxIdleCheckpointDue(
  db: Database,
  input: { intervalMs: number },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1) {
    throw new Error("idle checkpoint interval must be a positive safe integer");
  }
  return await probe(
    db,
    sql`select opengeni_private.sandbox_idle_checkpoint_due_v1(${input.intervalMs}::bigint) as due`,
  );
}

/** A browser on a warm box may need a provider-deadline or idle checkpoint. */
export async function browserDeadlineCheckpointDue(db: Database): Promise<boolean> {
  return await probe(db, sql`select opengeni_private.browser_deadline_checkpoint_due_v1() as due`);
}

/**
 * The sandbox reaper's maintenance pass may find database work: a warm or
 * held lease (metering, force drains, create recovery), a workspace marked for
 * a viewer force drain, or a due row for any reconciliation claim it runs. One
 * statement, so an idle tick is a single round trip.
 */
export async function sandboxMaintenanceDue(
  db: Database,
  input: { checkpointArtifactClaimTtlMs: number },
): Promise<boolean> {
  const ttl = input.checkpointArtifactClaimTtlMs;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 3_600_000) {
    throw new Error("checkpoint artifact claim TTL must be between 1 second and 1 hour");
  }
  return await probe(
    db,
    sql`select (
      opengeni_private.sandbox_lease_reaper_due_v1()
      or opengeni_private.session_system_update_outbox_due_v1()
      or opengeni_private.session_list_snapshots_expired_v1()
      or opengeni_private.connected_command_reconciliation_due_v1()
      or opengeni_private.connected_command_output_release_due_v1()
      or opengeni_private.terminal_retained_processes_due_v1()
      or opengeni_private.sandbox_ended_epoch_blockers_due_v1()
      or opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(${ttl}::bigint)
      or exists (select 1 from opengeni_private.list_sandbox_viewer_force_drain_workspaces())
    ) as due`,
  );
}
