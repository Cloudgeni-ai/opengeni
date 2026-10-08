import { and, eq, inArray, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

// The inbox (0654). Session events open and close items in the event writer's
// transaction; these owner-run functions read them and record the person's own
// attention. Every call is scoped to one account and one recipient subject.

export type InboxItemRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: "question" | "approval" | "goal_paused" | "notification";
  sourceKey: string;
  title: string;
  body: string;
  urgency: "normal" | "time_sensitive";
  status: "open" | "resolved" | "withdrawn" | "dismissed";
  unread: boolean;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

type InboxItemRecord = {
  id: string;
  workspace_id: string;
  session_id: string;
  kind: InboxItemRow["kind"];
  source_key: string;
  title: string;
  body: string;
  urgency: InboxItemRow["urgency"];
  status: InboxItemRow["status"];
  unread: boolean;
  snoozed_until: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

/** The person's open items in one account, newest first. */
export async function listInboxItems(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<InboxItemRow[]> {
  const rows = await rawRows<InboxItemRecord>(
    db,
    sql`select * from opengeni_private.list_inbox_items_v1(
      ${input.accountId}::uuid, ${input.subjectId}::text
    )`,
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    kind: row.kind,
    sourceKey: row.source_key,
    title: row.title,
    body: row.body,
    urgency: row.urgency,
    status: row.status,
    unread: row.unread,
    snoozedUntil: isoOrNull(row.snoozed_until),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: isoOrNull(row.resolved_at),
  }));
}

export type InboxItemRef = {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: InboxItemRow["kind"];
  sourceKey: string;
  status: InboxItemRow["status"];
};

/** One of the person's items, in any status; null when it is not theirs. */
export async function getInboxItem(
  db: Database,
  input: { itemId: string; accountId: string; subjectId: string },
): Promise<InboxItemRef | null> {
  const [row] = await rawRows<{
    id: string;
    workspace_id: string;
    session_id: string;
    kind: InboxItemRow["kind"];
    source_key: string;
    status: InboxItemRow["status"];
  }>(
    db,
    sql`select * from opengeni_private.inbox_item_v1(
      ${input.itemId}::uuid, ${input.accountId}::uuid, ${input.subjectId}::text
    )`,
  );
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        kind: row.kind,
        sourceKey: row.source_key,
        status: row.status,
      }
    : null;
}

/**
 * Record the person's attention on one of their items. `snoozedUntil: null`
 * unsnoozes; omit it to leave the snooze. Returns false when the item is not theirs.
 */
export async function updateInboxItemAttention(
  db: Database,
  input: {
    itemId: string;
    accountId: string;
    subjectId: string;
    seen?: boolean;
    snoozedUntil?: string | null;
    dismissed?: boolean;
  },
): Promise<boolean> {
  const setSnooze = input.snoozedUntil !== undefined;
  const [row] = await rawRows<{ id: string | null }>(
    db,
    sql`select opengeni_private.update_inbox_item_attention_v1(
      ${input.itemId}::uuid, ${input.accountId}::uuid, ${input.subjectId}::text,
      ${input.seen === true}::boolean, ${setSnooze}::boolean,
      ${setSnooze ? input.snoozedUntil : null}::timestamptz, ${input.dismissed === true}::boolean
    ) as id`,
  );
  return Boolean(row?.id);
}

/** An agent tidying the person's inbox; only notifications can be dismissed this way. */
export async function dismissInboxNotification(
  db: Database,
  input: { itemId: string; accountId: string; subjectId: string },
): Promise<boolean> {
  const [row] = await rawRows<{ id: string | null }>(
    db,
    sql`select opengeni_private.dismiss_inbox_notification_v1(
      ${input.itemId}::uuid, ${input.accountId}::uuid, ${input.subjectId}::text
    ) as id`,
  );
  return Boolean(row?.id);
}

export type InboxTidyPolicyValue = "own_sessions" | "any_agent";

export async function getInboxTidyPolicy(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<InboxTidyPolicyValue> {
  const [row] = await rawRows<{ policy: InboxTidyPolicyValue }>(
    db,
    sql`select opengeni_private.inbox_settings_v1(
      ${input.accountId}::uuid, ${input.subjectId}::text
    ) as policy`,
  );
  return row?.policy ?? "own_sessions";
}

export async function setInboxTidyPolicy(
  db: Database,
  input: { accountId: string; subjectId: string; policy: InboxTidyPolicyValue },
): Promise<InboxTidyPolicyValue> {
  const [row] = await rawRows<{ policy: InboxTidyPolicyValue }>(
    db,
    sql`select opengeni_private.set_inbox_settings_v1(
      ${input.accountId}::uuid, ${input.subjectId}::text, ${input.policy}::text
    ) as policy`,
  );
  return row?.policy ?? input.policy;
}

/** Titles of sessions in one workspace, read under that workspace's context. */
export async function getSessionTitles(
  db: Database,
  workspaceId: string,
  sessionIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (sessionIds.length === 0) return new Map();
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({ id: schema.sessions.id, title: schema.sessions.title })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          inArray(schema.sessions.id, [...sessionIds]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.title]));
  });
}
