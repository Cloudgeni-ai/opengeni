import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { siteDataReadReach, type SiteDataAccessMode } from "./site-data-policy";

// Migration 1519. App data changes as activity facts: the "This workspace"
// automation source reads them as its owner (row security narrows them to the
// Apps and records that person may see), and workspace webhooks subscribed to
// an app type get them through a trigger. Facts are written only while
// someone listens, so a workspace without listeners pays one lookup per write.

/** App event types, in the order the webhook and trigger catalogs list them. */
export const APP_ACTIVITY_EVENT_TYPES = [
  "app.record.added",
  "app.record.changed",
  "app.record.removed",
  "app.sql.changed",
] as const;
export type AppActivityEventType = (typeof APP_ACTIVITY_EVENT_TYPES)[number];

/** Record data kept on a fact; larger records set `recordTruncated` instead. */
export const APP_ACTIVITY_RECORD_BYTES = 4096;
/** Facts one write transaction records at most (a batch has at most 100 operations). */
export const APP_ACTIVITY_FACTS_PER_WRITE = 100;

export type AppActivityScope = { accountId: string; workspaceId: string; siteId: string };

/**
 * What caused a write: the person it ran for (null for none), the writer's
 * coarse kind, and the automation run behind it, whose chain depth the fact
 * carries so a loop of automations stops at the chain limit.
 */
export type AppActivityCause = {
  principal: string;
  writerKind: string;
  automationId?: string | null | undefined;
  automationRunId?: string | null | undefined;
  chainDepth?: number | undefined;
};

export type AppRecordChange = {
  change: "added" | "changed" | "removed";
  collection: { name: string; accessMode: SiteDataAccessMode; privateRecords: boolean };
  record: {
    id: string;
    key: string | null;
    owner: string;
    version: number;
    data: Record<string, unknown> | null;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function subjectOf(principal: string): string | null {
  return principal.startsWith("user:") && principal.length > 5
    ? principal.slice(5).slice(0, 1024)
    : null;
}

function depthOf(cause: AppActivityCause): number {
  const depth = Math.trunc(cause.chainDepth ?? 0);
  return Number.isFinite(depth) ? Math.max(0, Math.min(32767, depth)) : 0;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/**
 * Whether anyone listens for App facts in this workspace: an active "This
 * workspace" source or an enabled workspace webhook subscribed to an app type.
 */
export async function appActivityListening(tx: Database, workspaceId: string): Promise<boolean> {
  const [row] = await rawRows<{ listening: boolean }>(
    tx,
    sql`select (exists (select 1 from event_sources source
          where source.workspace_id = ${workspaceId} and source.kind = 'workspace'
            and source.status = 'active')
        or exists (select 1 from workspace_webhooks webhook
          where webhook.workspace_id = ${workspaceId} and webhook.enabled
            and webhook.event_types && ${sql.raw(
              `ARRAY[${APP_ACTIVITY_EVENT_TYPES.map((type) => `'${type}'`).join(",")}]::text[]`,
            )})) as listening`,
  );
  return row?.listening === true;
}

function readerOf(change: AppRecordChange): { reader: string | null; ownerOnly: boolean } {
  const rules = {
    accessMode: change.collection.accessMode,
    privateRecords: change.collection.privateRecords,
  };
  if (siteDataReadReach(rules, "viewer") === "all") return { reader: null, ownerOnly: false };
  const owner = change.record.owner;
  const reader = (subjectOf(owner) ?? `principal:${owner}`).slice(0, 1024);
  return { reader, ownerOnly: siteDataReadReach(rules, "manager") !== "all" };
}

function recordData(change: AppRecordChange): Record<string, unknown> {
  const data = change.record.data;
  if (data === null) return {};
  const text = JSON.stringify(data);
  return new TextEncoder().encode(text).byteLength <= APP_ACTIVITY_RECORD_BYTES
    ? { record: data }
    : { recordTruncated: true };
}

/**
 * Record one fact per changed App Data record, inside the write's
 * transaction, when someone listens. Never throws: a fact that can't be
 * written must not fail the write (a savepoint keeps the transaction usable).
 */
export async function recordAppRecordChangesInTransaction(
  tx: Database,
  scope: AppActivityScope,
  cause: AppActivityCause,
  changes: readonly AppRecordChange[],
): Promise<number> {
  if (changes.length === 0) return 0;
  try {
    return await tx.transaction(async (savepoint) => {
      if (!(await appActivityListening(savepoint, scope.workspaceId))) return 0;
      const subject = subjectOf(cause.principal);
      const depth = depthOf(cause);
      const runId = uuidOrNull(cause.automationRunId);
      const automationId = runId ? uuidOrNull(cause.automationId) : null;
      const rows = changes.slice(0, APP_ACTIVITY_FACTS_PER_WRITE).map((change) => {
        const { reader, ownerOnly } = readerOf(change);
        const ownerSubject = subjectOf(change.record.owner);
        const data = {
          collection: change.collection.name,
          change: change.change,
          recordId: change.record.id,
          ...(change.record.key !== null ? { recordKey: change.record.key } : {}),
          version: change.record.version,
          ...(ownerSubject ? { recordOwnerSubjectId: ownerSubject } : {}),
          writer: cause.writerKind,
          ...recordData(change),
        };
        return sql`(${scope.workspaceId}::uuid, gen_random_uuid(), ${scope.accountId}::uuid,
          ${`app.record.${change.change}`}, clock_timestamp(), ${subject}, ${automationId}::uuid,
          ${runId}::uuid, ${depth}, ${JSON.stringify(data)}::jsonb, ${scope.siteId}::uuid,
          ${reader}, ${ownerOnly})`;
      });
      await savepoint.execute(
        sql`insert into workspace_activity_events (workspace_id, id, account_id, type,
            occurred_at, subject_id, automation_id, automation_run_id, chain_depth, data,
            site_id, reader_subject_id, reader_owner_only)
          values ${sql.join(rows, sql`, `)}`,
      );
      return rows.length;
    });
  } catch (error) {
    console.warn(
      `[app-activity] record facts skipped for app ${scope.siteId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
}

/**
 * Record that an App SQL write committed (`app.sql.changed`). The App's
 * database commits outside Postgres, so this is written after it, best
 * effort: a crash between the two loses the fact, never the write.
 */
export async function recordAppSqlChange(
  db: Database,
  scope: AppActivityScope,
  cause: AppActivityCause,
  change: { query: string | null; rowsWritten: number },
): Promise<boolean> {
  if (!(change.rowsWritten > 0)) return false;
  try {
    return await withRlsContext(db, scope, async (tx) => {
      if (!(await appActivityListening(tx, scope.workspaceId))) return false;
      const runId = uuidOrNull(cause.automationRunId);
      const data = {
        ...(change.query ? { query: change.query } : {}),
        rowsWritten: Math.max(0, Math.trunc(change.rowsWritten)),
        writer: cause.writerKind,
      };
      await tx.execute(
        sql`insert into workspace_activity_events (workspace_id, id, account_id, type,
            occurred_at, subject_id, automation_id, automation_run_id, chain_depth, data, site_id)
          values (${scope.workspaceId}::uuid, gen_random_uuid(), ${scope.accountId}::uuid,
            'app.sql.changed', clock_timestamp(), ${subjectOf(cause.principal)},
            ${runId ? uuidOrNull(cause.automationId) : null}::uuid, ${runId}::uuid,
            ${depthOf(cause)}, ${JSON.stringify(data)}::jsonb, ${scope.siteId}::uuid)`,
      );
      return true;
    });
  } catch (error) {
    console.warn(
      `[app-activity] SQL fact skipped for app ${scope.siteId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export type AppAutomationCause = { taskId: string; runId: string; chainDepth: number };

/**
 * The automation run behind an agent's turn, followed like the chat facts of
 * migration 1105: the turn's own run; for a later turn Opengeni started in an
 * automation's chat, that chat's run; or for a chat an agent started inside
 * another chat's turn, the nearest run up the chain (at most 8 chats up).
 */
export async function getAppAutomationCause(
  db: Database,
  scope: { accountId: string; workspaceId: string },
  input: { sessionId: string; turnId: string | null },
): Promise<AppAutomationCause | null> {
  if (!UUID.test(input.sessionId)) return null;
  return withRlsContext(db, scope, async (tx) => {
    let runId: string | null = null;
    let initiatorKind: string | null = null;
    if (input.turnId && UUID.test(input.turnId)) {
      const [turn] = await rawRows<{ run: string | null; initiator_kind: string | null }>(
        tx,
        sql`select scheduled_task_run_id as run, initiator_kind from session_turns
          where id = ${input.turnId} and workspace_id = ${scope.workspaceId}`,
      );
      runId = turn?.run ?? null;
      initiatorKind = turn?.initiator_kind ?? null;
    } else {
      const [run] = await rawRows<{ id: string }>(
        tx,
        sql`select id from scheduled_task_runs
          where workspace_id = ${scope.workspaceId} and session_id = ${input.sessionId} limit 1`,
      );
      runId = run?.id ?? null;
    }
    let session: string | null = input.sessionId;
    for (let hops = 0; runId === null && session !== null && hops < 8; hops += 1) {
      type ChatRow = { parent_turn_id: string | null; metadata_run: string | null };
      const [chat]: ChatRow[] = await rawRows<ChatRow>(
        tx,
        sql`select parent_turn_id, metadata ->> 'scheduledTaskRunId' as metadata_run from sessions
          where id = ${session} and workspace_id = ${scope.workspaceId}`,
      );
      if (!chat) break;
      if (
        hops === 0 &&
        input.turnId &&
        initiatorKind !== "subject" &&
        chat.metadata_run &&
        UUID.test(chat.metadata_run)
      ) {
        runId = chat.metadata_run;
        break;
      }
      if (!chat.parent_turn_id) break;
      type ParentRow = { run: string | null; session_id: string };
      const [parent]: ParentRow[] = await rawRows<ParentRow>(
        tx,
        sql`select scheduled_task_run_id as run, session_id from session_turns
          where id = ${chat.parent_turn_id} and workspace_id = ${scope.workspaceId}`,
      );
      if (!parent) break;
      runId = parent.run;
      session = parent.session_id;
    }
    if (!runId) return null;
    const [run] = await rawRows<{ task_id: string; chain_depth: number | string | null }>(
      tx,
      sql`select task_id, chain_depth from scheduled_task_runs
        where id = ${runId} and workspace_id = ${scope.workspaceId}`,
    );
    return run ? { taskId: run.task_id, runId, chainDepth: Number(run.chain_depth ?? 1) } : null;
  });
}
