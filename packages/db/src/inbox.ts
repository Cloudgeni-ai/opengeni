import { LOCAL_HUMAN_SUBJECT_ID } from "@opengeni/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
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
    sql`select * from opengeni_private.list_inbox_items_v2(
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

export type InboxSettingsValue = {
  tidyPolicy: InboxTidyPolicyValue;
  pausedGoals: boolean;
  replies: boolean;
};

type InboxSettingsRecord = {
  tidy_policy: InboxTidyPolicyValue;
  paused_goals: boolean;
  replies: boolean;
};

/** The person's inbox settings in one account (0663, 0665). */
export async function getInboxSettings(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<InboxSettingsValue> {
  const [row] = await rawRows<InboxSettingsRecord>(
    db,
    sql`select * from opengeni_private.inbox_settings_v3(
      ${input.accountId}::uuid, ${input.subjectId}::text
    )`,
  );
  return {
    tidyPolicy: row?.tidy_policy ?? "own_sessions",
    pausedGoals: row?.paused_goals ?? false,
    replies: row?.replies ?? false,
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
  },
): Promise<InboxSettingsValue> {
  const [row] = await rawRows<InboxSettingsRecord>(
    db,
    sql`select * from opengeni_private.set_inbox_settings_v3(
      ${input.accountId}::uuid, ${input.subjectId}::text,
      ${input.tidyPolicy ?? null}::text, ${input.pausedGoals ?? null}::boolean,
      ${input.replies ?? null}::boolean
    )`,
  );
  return {
    tidyPolicy: row?.tidy_policy ?? input.tidyPolicy ?? "own_sessions",
    pausedGoals: row?.paused_goals ?? input.pausedGoals ?? false,
    replies: row?.replies ?? input.replies ?? false,
  };
}

/**
 * The person a session works for (its owner, else who started it, else the
 * owner of the schedule whose run created it; on a local install, its one
 * human) and its parent, or null when no person does. Mirrors
 * `session_person_v1`, which the inbox projection uses (0661, 0677).
 */
export async function getSessionInboxRecipient(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{ subjectId: string; parentSessionId: string | null } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        accountId: schema.sessions.accountId,
        owner: schema.sessions.ownerSubjectId,
        creator: schema.sessions.createdBySubjectId,
        parent: schema.sessions.parentSessionId,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    let subjectId = row.owner?.startsWith("user:")
      ? row.owner
      : row.creator.startsWith("user:")
        ? row.creator
        : null;
    let scheduleOwner: string | null = null;
    if (!subjectId) {
      // A scheduled run works for the schedule's owner (0661).
      const [run] = await scopedDb
        .select({ owner: schema.scheduledTasks.ownerSubjectId })
        .from(schema.scheduledTaskRuns)
        .innerJoin(
          schema.scheduledTasks,
          eq(schema.scheduledTasks.id, schema.scheduledTaskRuns.taskId),
        )
        .where(
          and(
            eq(schema.scheduledTaskRuns.workspaceId, workspaceId),
            eq(schema.scheduledTaskRuns.sessionId, sessionId),
          ),
        )
        .orderBy(desc(schema.scheduledTaskRuns.createdAt))
        .limit(1);
      scheduleOwner = run?.owner ?? null;
      subjectId = scheduleOwner?.startsWith("user:") ? scheduleOwner : null;
    }
    if (
      !subjectId &&
      [row.owner, row.creator, scheduleOwner].includes(LOCAL_HUMAN_SUBJECT_ID) &&
      (await isLocalInstallAccount(scopedDb, row.accountId))
    ) {
      // A local install's one human, only inside its own organization (0677).
      subjectId = LOCAL_HUMAN_SUBJECT_ID;
    }
    return subjectId ? { subjectId, parentSessionId: row.parent ?? null } : null;
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
          inArray(schema.sessions.id, [...sessionIds]),
        ),
      );
    return new Map(rows.map((row) => [row.id, row.title]));
  });
}

/** The built-in organization of a local install (`opengeni:local`/`default`). */
async function isLocalInstallAccount(db: Database, accountId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: schema.managedAccounts.id })
    .from(schema.managedAccounts)
    .where(
      and(
        eq(schema.managedAccounts.id, accountId),
        eq(schema.managedAccounts.externalSource, "opengeni:local"),
        eq(schema.managedAccounts.externalId, "default"),
      ),
    )
    .limit(1);
  return Boolean(account);
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
