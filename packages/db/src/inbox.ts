import { and, eq, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import { anyOf } from "./sql-arrays";
import * as schema from "./schema";

// The inbox (0655). Session events open and close items in the event writer's
// transaction; these owner-run functions read them and record the person's own
// attention. Every call is scoped to one account and one recipient subject.

export type InboxItemRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: "question" | "approval" | "goal_paused" | "notification" | "reply";
  sourceKey: string;
  title: string;
  subtitle: string;
  body: string;
  facts: Array<{ label: string; value: string }>;
  link: { url: string; label: string } | null;
  eventSequence: number | null;
  choices: Array<{ id: string; label: string }>;
  urgency: "normal" | "time_sensitive";
  status: "open" | "resolved" | "withdrawn" | "dismissed";
  unread: boolean;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Another member whose agent sent this notification (0708); null for the person's own. */
  sender: { subjectId: string; label: string } | null;
};

type InboxItemRecord = {
  id: string;
  workspace_id: string;
  session_id: string;
  kind: InboxItemRow["kind"];
  source_key: string;
  title: string;
  subtitle: string;
  body: string;
  facts: unknown;
  link: unknown;
  event_sequence: number | null;
  choices: unknown;
  urgency: InboxItemRow["urgency"];
  status: InboxItemRow["status"];
  unread: boolean;
  snoozed_until: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
  sender_subject_id: string | null;
  sender_label: string | null;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function choicesOf(value: unknown): Array<{ id: string; label: string }> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((choice: unknown) => {
    if (typeof choice !== "object" || choice === null) return [];
    const { id, label } = choice as { id?: unknown; label?: unknown };
    return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
  });
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function factsOf(value: unknown): Array<{ label: string; value: string }> {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((fact: unknown) => {
      if (typeof fact !== "object" || fact === null) return [];
      const { label, value: text } = fact as { label?: unknown; value?: unknown };
      return typeof label === "string" && typeof text === "string" ? [{ label, value: text }] : [];
    })
    .slice(0, 4);
}

function linkOf(value: unknown): { url: string; label: string } | null {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null) return null;
  const { url, label } = parsed as { url?: unknown; label?: unknown };
  return typeof url === "string" && /^https:\/\//iu.test(url) && typeof label === "string"
    ? { url, label }
    : null;
}

/** The person's open items in one account, newest first. */
export async function listInboxItems(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<InboxItemRow[]> {
  const rows = await rawRows<InboxItemRecord>(
    db,
    sql`select * from opengeni_private.list_inbox_items_v3(
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
    subtitle: row.subtitle ?? "",
    body: row.body,
    facts: factsOf(row.facts),
    link: linkOf(row.link),
    eventSequence: row.event_sequence ?? null,
    choices: choicesOf(row.choices),
    urgency: row.urgency,
    status: row.status,
    unread: row.unread,
    snoozedUntil: isoOrNull(row.snoozed_until),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: isoOrNull(row.resolved_at),
    sender: row.sender_subject_id
      ? { subjectId: row.sender_subject_id, label: row.sender_label ?? "A teammate" }
      : null,
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

export type InboxTidyPolicyValue = "own_sessions" | "any_agent" | "full_access";

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

export type InboxSettingsValue = {
  tidyPolicy: InboxTidyPolicyValue;
  pausedGoals: boolean;
  replies: boolean;
  /** Question and approval alerts arrive time-sensitive (0718). */
  timeSensitiveNeedsYou: boolean;
};

type InboxSettingsRecord = {
  tidy_policy: InboxTidyPolicyValue;
  paused_goals: boolean;
  replies: boolean;
  time_sensitive_needs_you: boolean;
};

/** The person's inbox settings in one account (0663, 0665, 0718). */
export async function getInboxSettings(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<InboxSettingsValue> {
  const [row] = await rawRows<InboxSettingsRecord>(
    db,
    sql`select * from opengeni_private.inbox_settings_v4(
      ${input.accountId}::uuid, ${input.subjectId}::text
    )`,
  );
  return {
    tidyPolicy: row?.tidy_policy ?? "own_sessions",
    pausedGoals: row?.paused_goals ?? false,
    replies: row?.replies ?? false,
    timeSensitiveNeedsYou: row?.time_sensitive_needs_you ?? false,
  };
}

/**
 * Change some of the person's inbox settings; omitted ones stay as they are.
 * Turning replies off takes the reply items out of the inbox.
 */
export async function setInboxSettings(
  db: Database,
  input: {
    accountId: string;
    subjectId: string;
    tidyPolicy?: InboxTidyPolicyValue | undefined;
    pausedGoals?: boolean | undefined;
    replies?: boolean | undefined;
    timeSensitiveNeedsYou?: boolean | undefined;
  },
): Promise<InboxSettingsValue> {
  const [row] = await rawRows<InboxSettingsRecord>(
    db,
    sql`select * from opengeni_private.set_inbox_settings_v4(
      ${input.accountId}::uuid, ${input.subjectId}::text,
      ${input.tidyPolicy ?? null}::text, ${input.pausedGoals ?? null}::boolean,
      ${input.replies ?? null}::boolean, ${input.timeSensitiveNeedsYou ?? null}::boolean
    )`,
  );
  return {
    tidyPolicy: row?.tidy_policy ?? input.tidyPolicy ?? "own_sessions",
    pausedGoals: row?.paused_goals ?? input.pausedGoals ?? false,
    replies: row?.replies ?? input.replies ?? false,
    timeSensitiveNeedsYou: row?.time_sensitive_needs_you ?? input.timeSensitiveNeedsYou ?? false,
  };
}

/**
 * A turn works for its initiating human, including an explicitly absent human.
 * Legacy non-turn inbox operations retain the session recipient convention.
 */
export async function getSessionInboxRecipient(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId?: string,
): Promise<{ subjectId: string; parentSessionId: string | null } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute(sql`
      WITH recipient AS (
        SELECT s.parent_session_id, s.account_id,
          CASE WHEN ${turnId ?? null}::uuid IS NOT NULL THEN ARRAY[t.initiating_human_subject_id]
          ELSE ARRAY[s.owner_subject_id, s.created_by_subject_id, (
            SELECT task.owner_subject_id FROM scheduled_task_runs run
            JOIN scheduled_tasks task ON task.id = run.task_id
            WHERE run.workspace_id = s.workspace_id AND run.session_id = s.id
            ORDER BY run.created_at DESC LIMIT 1
          )] END AS subjects
        FROM sessions s LEFT JOIN session_turns t
          ON t.workspace_id = s.workspace_id AND t.session_id = s.id
          AND t.id = ${turnId ?? null}::uuid
        WHERE s.workspace_id = ${workspaceId}::uuid AND s.id = ${sessionId}::uuid
      )
      SELECT coalesce(
        (SELECT subject FROM unnest(subjects) WITH ORDINALITY AS candidates(subject, position)
          WHERE subject LIKE 'user:%' ORDER BY position LIMIT 1),
        CASE WHEN 'dev' = ANY(subjects) AND EXISTS (
          SELECT 1 FROM managed_accounts a WHERE a.id = recipient.account_id
            AND a.external_source = 'opengeni:local' AND a.external_id = 'default'
        ) THEN 'dev' END
      ) AS subject_id, parent_session_id FROM recipient
    `);
    const row = rows[0] as
      | { subject_id: string | null; parent_session_id: string | null }
      | undefined;
    return row?.subject_id
      ? { subjectId: row.subject_id, parentSessionId: row.parent_session_id }
      : null;
  });
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
          anyOf(schema.sessions.id, [...sessionIds]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.title]));
  });
}

/** The session's account, read under its workspace's context, or null if it isn't there. */
async function sessionAccount(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<string | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ accountId: schema.sessions.accountId })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return row?.accountId ?? null;
  });
}

/**
 * Whether this person lets other members' agents notify them in this
 * workspace (0708). Off unless they turned it on.
 */
export async function getMemberNotificationsAllowed(
  db: Database,
  input: { workspaceId: string; subjectId: string },
): Promise<boolean> {
  const [row] = await rawRows<{ allowed: boolean }>(
    db,
    sql`select opengeni_private.member_notifications_allowed_v1(
      ${input.workspaceId}::uuid, ${input.subjectId}::text
    ) as allowed`,
  );
  return row?.allowed ?? false;
}

/** Turn other members' agent notifications on or off for this person in this workspace. */
export async function setMemberNotificationsAllowed(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; allowed: boolean },
): Promise<boolean> {
  const [row] = await rawRows<{ allowed: boolean }>(
    db,
    sql`select opengeni_private.set_member_notifications_allowed_v1(
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}::text,
      ${input.allowed}::boolean
    ) as allowed`,
  );
  return row?.allowed ?? input.allowed;
}

/**
 * Whether this person muted the session's replies (0678), or null when the
 * session is not in the workspace.
 */
export async function getSessionRepliesMuted(
  db: Database,
  input: { workspaceId: string; sessionId: string; subjectId: string },
): Promise<boolean | null> {
  if (!(await sessionAccount(db, input.workspaceId, input.sessionId))) return null;
  const [row] = await rawRows<{ muted: boolean }>(
    db,
    sql`select opengeni_private.session_replies_muted_for_v1(
      ${input.sessionId}::uuid, ${input.subjectId}::text
    ) as muted`,
  );
  return row?.muted ?? false;
}

/**
 * Mute or unmute the session's replies for this person (0678). Muting takes
 * its current reply out of their inbox. Null when the session is not in the
 * workspace.
 */
export async function setSessionRepliesMuted(
  db: Database,
  input: { workspaceId: string; sessionId: string; subjectId: string; muted: boolean },
): Promise<boolean | null> {
  const accountId = await sessionAccount(db, input.workspaceId, input.sessionId);
  if (!accountId) return null;
  const [row] = await rawRows<{ muted: boolean }>(
    db,
    sql`select opengeni_private.set_session_replies_muted_v1(
      ${accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
      ${input.subjectId}::text, ${input.muted}::boolean
    ) as muted`,
  );
  return row?.muted ?? input.muted;
}
