/**
 * Occasional update messages about Slack agents: reads and writes.
 *
 * Every row is HOME-owned, like `slack_agents`: the Slack installation's
 * binding `(accountId, workspaceId, connectionId)` writes it. The only
 * cross-tenant read is the sweeper's ids-only inventory definer
 * (`list_due_slack_agent_update_installations_v1`), withheld from the runtime
 * until a follow-up migration grants it.
 *
 * Who may change the settings is decided by callers from live grants.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { rawRows, withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type SlackAgentUpdateHome = { accountId: string; workspaceId: string };

export type SlackAgentUpdateKind = "welcome" | "update" | "dormant";

export type SlackAgentUpdateProfileState =
  | "eligible"
  | "guest"
  | "external"
  | "deactivated"
  | "bot";

export type SlackAgentUpdateSettingsRecord = {
  connectionId: string;
  updatesEnabled: boolean;
  channelPostsOnly: boolean;
  updatesEnabledAt: Date | null;
  updatedBySubjectId: string | null;
  updatedAt: Date | null;
};

/** Update messages are off until an organization admin turns them on. */
export function defaultSlackAgentUpdateSettings(
  connectionId: string,
): SlackAgentUpdateSettingsRecord {
  return {
    connectionId,
    updatesEnabled: false,
    channelPostsOnly: false,
    updatesEnabledAt: null,
    updatedBySubjectId: null,
    updatedAt: null,
  };
}

function mapSettings(
  row: typeof schema.slackAgentUpdateSettings.$inferSelect,
): SlackAgentUpdateSettingsRecord {
  return {
    connectionId: row.connectionId,
    updatesEnabled: row.updatesEnabled,
    channelPostsOnly: row.channelPostsOnly,
    updatesEnabledAt: row.updatesEnabledAt,
    updatedBySubjectId: row.updatedBySubjectId,
    updatedAt: row.updatedAt,
  };
}

export async function getSlackAgentUpdateSettings(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string },
): Promise<SlackAgentUpdateSettingsRecord> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.slackAgentUpdateSettings)
      .where(
        and(
          eq(schema.slackAgentUpdateSettings.workspaceId, home.workspaceId),
          eq(schema.slackAgentUpdateSettings.connectionId, input.connectionId),
        ),
      )
      .limit(1);
    return row ? mapSettings(row) : defaultSlackAgentUpdateSettings(input.connectionId);
  });
}

/**
 * Save the organization admin's choices. Turning update messages on stamps
 * `updatesEnabledAt`, so people who linked Slack before that are never sent a
 * welcome.
 */
export async function saveSlackAgentUpdateSettings(
  db: Database,
  home: SlackAgentUpdateHome,
  input: {
    connectionId: string;
    updatesEnabled: boolean;
    channelPostsOnly: boolean;
    subjectId: string;
  },
): Promise<SlackAgentUpdateSettingsRecord> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .insert(schema.slackAgentUpdateSettings)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        updatesEnabled: input.updatesEnabled,
        channelPostsOnly: input.channelPostsOnly,
        updatesEnabledAt: input.updatesEnabled ? sql`now()` : null,
        updatedBySubjectId: input.subjectId,
      })
      .onConflictDoUpdate({
        target: schema.slackAgentUpdateSettings.connectionId,
        set: {
          updatesEnabled: input.updatesEnabled,
          channelPostsOnly: input.channelPostsOnly,
          updatesEnabledAt: input.updatesEnabled
            ? sql`coalesce(case when ${schema.slackAgentUpdateSettings.updatesEnabled} then ${schema.slackAgentUpdateSettings.updatesEnabledAt} end, now())`
            : null,
          updatedBySubjectId: input.subjectId,
          version: sql`${schema.slackAgentUpdateSettings.version} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("Slack agent update settings write returned no row");
    return mapSettings(row);
  });
}

/**
 * Whether Opengeni may send direct messages about agents through this
 * installation. "Channel posts only" means agents are announced only through
 * channel intro posts.
 */
export async function slackAgentDirectMessagesAllowed(
  db: Database,
  home: SlackAgentUpdateHome,
  connectionId: string,
): Promise<boolean> {
  const settings = await getSlackAgentUpdateSettings(db, home, { connectionId });
  return !settings.channelPostsOnly;
}

export type SlackAgentUpdateSweepInstallation = {
  accountId: string;
  workspaceId: string;
  connectionId: string;
  updatesEnabledAt: Date | null;
};

const UPDATE_SWEEP_INVENTORY =
  "opengeni_private.list_due_slack_agent_update_installations_v1(integer)";

/**
 * Whether the runtime may call the sweeper's inventory yet. False while its
 * EXECUTE grant is withheld (1153) or the routine is absent. A separate
 * statement: EXECUTE is checked when a statement starts.
 */
export async function slackAgentUpdateSweepGranted(
  db: Pick<Database, "execute">,
): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(to_regprocedure(${UPDATE_SWEEP_INVENTORY})::oid, 'EXECUTE')
      as granted`,
  );
  return row?.granted === true;
}

/**
 * The installations that send update messages, across every organization,
 * least recently swept first. Ids only, through the sweeper's definer; empty
 * until that definer is granted.
 */
export async function listSlackAgentUpdateSweepInstallations(
  db: Database,
  input: { limit: number },
): Promise<SlackAgentUpdateSweepInstallation[]> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  if (!(await slackAgentUpdateSweepGranted(db))) return [];
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    connection_id: string;
    updates_enabled_at: Date | string | null;
  }>(
    db,
    sql`select account_id, workspace_id, connection_id, updates_enabled_at
      from opengeni_private.list_due_slack_agent_update_installations_v1(${limit})`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    updatesEnabledAt: row.updates_enabled_at ? new Date(row.updates_enabled_at) : null,
  }));
}

/**
 * Take one installation's sweep for a while, so replicas never sweep the same
 * installation at once and one installation is swept at most every
 * `minIntervalMs`. False when another holder has it or it ran recently.
 */
export async function claimSlackAgentUpdateSweep(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string; holder: string; leaseMs: number; minIntervalMs: number },
): Promise<boolean> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateSettings;
    const rows = await scopedDb
      .update(table)
      .set({
        sweepHolder: input.holder,
        sweepLeaseUntil: sql`now() + ${Math.max(1_000, input.leaseMs)} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(table.workspaceId, home.workspaceId),
          eq(table.connectionId, input.connectionId),
          eq(table.updatesEnabled, true),
          eq(table.channelPostsOnly, false),
          sql`(${table.sweepLeaseUntil} is null or ${table.sweepLeaseUntil} <= now())`,
          sql`(${table.lastSweptAt} is null or ${table.lastSweptAt} <= now() - ${Math.max(0, input.minIntervalMs)} * interval '1 millisecond')`,
        ),
      )
      .returning({ id: table.id });
    return rows.length > 0;
  });
}

export async function finishSlackAgentUpdateSweep(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string; holder: string },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateSettings;
    await scopedDb
      .update(table)
      .set({ sweepHolder: null, sweepLeaseUntil: null, lastSweptAt: sql`now()` })
      .where(
        and(
          eq(table.workspaceId, home.workspaceId),
          eq(table.connectionId, input.connectionId),
          eq(table.sweepHolder, input.holder),
        ),
      );
  });
}

export type SlackAgentUpdateAudienceMember = {
  linkId: string;
  slackUserId: string;
  subjectId: string;
  linkedAt: Date;
  updatesMutedAt: Date | null;
};

export type SlackAgentUpdateRecipientRecord = {
  slackUserId: string;
  tz: string | null;
  tzOffset: number | null;
  profileState: SlackAgentUpdateProfileState | null;
  profileCheckedAt: Date | null;
  lastSentAt: Date | null;
  lastKind: SlackAgentUpdateKind | null;
  welcomeSentAt: Date | null;
  dormantSentAt: Date | null;
  announcedAgentIds: string[];
};

export type SlackAgentUseRecord = {
  slackUserId: string;
  slackAgentId: string;
  lastUsedAt: Date;
};

/**
 * Everything one sweep of one installation needs, in one transaction: linked
 * people, what each was sent, and which agents each already used.
 */
export async function loadSlackAgentUpdateAudience(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string },
): Promise<{
  members: SlackAgentUpdateAudienceMember[];
  recipients: Map<string, SlackAgentUpdateRecipientRecord>;
  uses: SlackAgentUseRecord[];
}> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const links = await scopedDb
      .select({
        id: schema.slackBotUserLinks.id,
        slackUserId: schema.slackBotUserLinks.slackUserId,
        subjectId: schema.slackBotUserLinks.subjectId,
        createdAt: schema.slackBotUserLinks.createdAt,
        updatesMutedAt: schema.slackBotUserLinks.updatesMutedAt,
      })
      .from(schema.slackBotUserLinks)
      .where(
        and(
          eq(schema.slackBotUserLinks.workspaceId, home.workspaceId),
          eq(schema.slackBotUserLinks.connectionId, input.connectionId),
        ),
      )
      .orderBy(asc(schema.slackBotUserLinks.id));
    const recipientRows = await scopedDb
      .select()
      .from(schema.slackAgentUpdateRecipients)
      .where(
        and(
          eq(schema.slackAgentUpdateRecipients.workspaceId, home.workspaceId),
          eq(schema.slackAgentUpdateRecipients.connectionId, input.connectionId),
        ),
      );
    const useRows = await scopedDb
      .select({
        slackUserId: schema.slackAgentUserStates.slackUserId,
        slackAgentId: schema.slackAgentUserStates.slackAgentId,
        updatedAt: schema.slackAgentUserStates.updatedAt,
      })
      .from(schema.slackAgentUserStates)
      .where(
        and(
          eq(schema.slackAgentUserStates.workspaceId, home.workspaceId),
          eq(schema.slackAgentUserStates.connectionId, input.connectionId),
        ),
      );
    return {
      members: links.map((row) => ({
        linkId: row.id,
        slackUserId: row.slackUserId,
        subjectId: row.subjectId,
        linkedAt: row.createdAt,
        updatesMutedAt: row.updatesMutedAt,
      })),
      recipients: new Map(recipientRows.map((row) => [row.slackUserId, mapRecipient(row)])),
      uses: useRows.map((row) => ({
        slackUserId: row.slackUserId,
        slackAgentId: row.slackAgentId,
        lastUsedAt: row.updatedAt,
      })),
    };
  });
}

function mapRecipient(
  row: typeof schema.slackAgentUpdateRecipients.$inferSelect,
): SlackAgentUpdateRecipientRecord {
  return {
    slackUserId: row.slackUserId,
    tz: row.tz,
    tzOffset: row.tzOffset,
    profileState: row.profileState,
    profileCheckedAt: row.profileCheckedAt,
    lastSentAt: row.lastSentAt,
    lastKind: row.lastKind,
    welcomeSentAt: row.welcomeSentAt,
    dormantSentAt: row.dormantSentAt,
    announcedAgentIds: row.announcedAgentIds ?? [],
  };
}

/** Cache one person's Slack profile facts (time zone, guest, external, active). */
export async function saveSlackAgentUpdateRecipientProfile(
  db: Database,
  home: SlackAgentUpdateHome,
  input: {
    connectionId: string;
    slackUserId: string;
    tz: string | null;
    tzOffset: number | null;
    profileState: SlackAgentUpdateProfileState;
    checkedAt: Date;
  },
): Promise<SlackAgentUpdateRecipientRecord> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const values = {
      tz: input.tz,
      tzOffset: input.tzOffset,
      profileState: input.profileState,
      profileCheckedAt: input.checkedAt,
    };
    const [row] = await scopedDb
      .insert(schema.slackAgentUpdateRecipients)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackUserId: input.slackUserId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          schema.slackAgentUpdateRecipients.connectionId,
          schema.slackAgentUpdateRecipients.slackUserId,
        ],
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error("Slack agent update recipient write returned no row");
    return mapRecipient(row);
  });
}

export type SlackAgentUpdateDeliveryRecord = {
  id: string;
  connectionId: string;
  slackUserId: string;
  kind: SlackAgentUpdateKind;
  dedupeKey: string;
  operationId: string;
  agentIds: string[];
  text: string;
  blocks: unknown[];
  state: "pending" | "sent" | "failed";
  attempts: number;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  errorCode: string | null;
  createdAt: Date;
  sentAt: Date | null;
};

function mapDelivery(
  row: typeof schema.slackAgentUpdateDeliveries.$inferSelect,
): SlackAgentUpdateDeliveryRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    slackUserId: row.slackUserId,
    kind: row.kind,
    dedupeKey: row.dedupeKey,
    operationId: row.operationId,
    agentIds: row.agentIds ?? [],
    text: row.text,
    blocks: row.blocks,
    state: row.state,
    attempts: row.attempts,
    slackChannelId: row.slackChannelId,
    slackMessageTs: row.slackMessageTs,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

export const SLACK_AGENT_UPDATE_MIN_GAP_MS = 30 * 24 * 60 * 60 * 1_000;

export type SlackAgentUpdateClaim =
  | { kind: "claimed"; delivery: SlackAgentUpdateDeliveryRecord }
  | { kind: "skipped"; reason: "muted" | "unlinked" | "already_sent" | "too_soon" | "not_dormant" };

/**
 * Durably decide to send one update message, then record it, in one
 * transaction that holds the person's row. The limits are checked again
 * under that lock, so two sweepers (or a retry) never both send. The caller
 * posts afterwards with the delivery's stored operation id, text and blocks.
 */
export async function claimSlackAgentUpdateDelivery(
  db: Database,
  home: SlackAgentUpdateHome,
  input: {
    connectionId: string;
    slackUserId: string;
    kind: SlackAgentUpdateKind;
    dedupeKey: string;
    operationId: string;
    agentIds: string[];
    text: string;
    blocks: unknown[];
    now: Date;
    /** For a dormant reminder: when the person last used an agent or linked Slack. */
    dormantSince?: Date | null;
    /** An update to someone dormant also counts as their dormant reminder. */
    alsoDormantReminder?: boolean;
  },
): Promise<SlackAgentUpdateClaim> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const link = await rawRows<{ updates_muted_at: Date | string | null }>(
      scopedDb,
      sql`select updates_muted_at from slack_bot_user_links
        where workspace_id = ${home.workspaceId} and connection_id = ${input.connectionId}
          and slack_user_id = ${input.slackUserId}
        for share`,
    );
    if (link.length === 0) return { kind: "skipped", reason: "unlinked" };
    if (link[0]!.updates_muted_at) return { kind: "skipped", reason: "muted" };
    await scopedDb
      .insert(schema.slackAgentUpdateRecipients)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackUserId: input.slackUserId,
      })
      .onConflictDoNothing();
    const [current] = await scopedDb
      .select()
      .from(schema.slackAgentUpdateRecipients)
      .where(
        and(
          eq(schema.slackAgentUpdateRecipients.workspaceId, home.workspaceId),
          eq(schema.slackAgentUpdateRecipients.connectionId, input.connectionId),
          eq(schema.slackAgentUpdateRecipients.slackUserId, input.slackUserId),
        ),
      )
      .for("update");
    if (!current) throw new Error("Slack agent update recipient row is missing");
    const recipient = mapRecipient(current);
    const nowMs = input.now.getTime();
    if (input.kind === "welcome") {
      if (recipient.welcomeSentAt) return { kind: "skipped", reason: "already_sent" };
    } else {
      if (
        recipient.lastSentAt &&
        nowMs - recipient.lastSentAt.getTime() < SLACK_AGENT_UPDATE_MIN_GAP_MS
      ) {
        return { kind: "skipped", reason: "too_soon" };
      }
      if (input.kind === "dormant") {
        const since = input.dormantSince ?? null;
        if (!since) return { kind: "skipped", reason: "not_dormant" };
        if (recipient.dormantSentAt && recipient.dormantSentAt.getTime() >= since.getTime()) {
          return { kind: "skipped", reason: "already_sent" };
        }
      }
    }
    const [delivery] = await scopedDb
      .insert(schema.slackAgentUpdateDeliveries)
      .values({
        accountId: home.accountId,
        workspaceId: home.workspaceId,
        connectionId: input.connectionId,
        slackUserId: input.slackUserId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        operationId: input.operationId,
        agentIds: input.agentIds,
        text: input.text,
        blocks: input.blocks,
        nextAttemptAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    if (!delivery) return { kind: "skipped", reason: "already_sent" };
    const announced = [...new Set([...recipient.announcedAgentIds, ...input.agentIds])].slice(
      -1_000,
    );
    const dormantReminder = input.kind === "dormant" || input.alsoDormantReminder === true;
    await scopedDb
      .update(schema.slackAgentUpdateRecipients)
      .set({
        lastSentAt: input.now,
        lastKind: input.kind,
        ...(input.kind === "welcome" ? { welcomeSentAt: input.now } : {}),
        ...(dormantReminder ? { dormantSentAt: input.now } : {}),
        announcedAgentIds: announced,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.slackAgentUpdateRecipients.id, current.id));
    return { kind: "claimed", delivery: mapDelivery(delivery) };
  });
}

/** Recorded messages still waiting to go out (first attempt or a retry). */
export async function listPendingSlackAgentUpdateDeliveries(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string; now: Date; limit: number },
): Promise<SlackAgentUpdateDeliveryRecord[]> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateDeliveries;
    const rows = await scopedDb
      .select()
      .from(table)
      .where(
        and(
          eq(table.workspaceId, home.workspaceId),
          eq(table.connectionId, input.connectionId),
          eq(table.state, "pending"),
          lte(table.nextAttemptAt, input.now),
        ),
      )
      .orderBy(asc(table.nextAttemptAt), asc(table.id))
      .limit(Math.max(1, Math.min(100, Math.trunc(input.limit))));
    return rows.map(mapDelivery);
  });
}

export async function markSlackAgentUpdateDeliverySent(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { deliveryId: string; slackChannelId: string; slackMessageTs: string },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateDeliveries;
    await scopedDb
      .update(table)
      .set({
        state: "sent",
        attempts: sql`${table.attempts} + 1`,
        slackChannelId: input.slackChannelId,
        slackMessageTs: input.slackMessageTs,
        errorCode: null,
        sentAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(table.workspaceId, home.workspaceId), eq(table.id, input.deliveryId)));
  });
}

/**
 * Record a failed attempt. With `retryAt` the message stays pending and is
 * sent again under the same operation id; without it, it is given up.
 */
export async function markSlackAgentUpdateDeliveryFailed(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { deliveryId: string; errorCode: string; retryAt: Date | null },
): Promise<void> {
  await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateDeliveries;
    await scopedDb
      .update(table)
      .set({
        state: input.retryAt ? "pending" : "failed",
        attempts: sql`${table.attempts} + 1`,
        ...(input.retryAt ? { nextAttemptAt: input.retryAt } : {}),
        errorCode: input.errorCode.slice(0, 128) || "unknown_error",
        updatedAt: sql`now()`,
      })
      .where(and(eq(table.workspaceId, home.workspaceId), eq(table.id, input.deliveryId)));
  });
}

/** The deliveries recorded for one person, newest first. */
export async function listSlackAgentUpdateDeliveriesFor(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string; slackUserId: string },
): Promise<SlackAgentUpdateDeliveryRecord[]> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const table = schema.slackAgentUpdateDeliveries;
    const rows = await scopedDb
      .select()
      .from(table)
      .where(
        and(
          eq(table.workspaceId, home.workspaceId),
          eq(table.connectionId, input.connectionId),
          eq(table.slackUserId, input.slackUserId),
        ),
      )
      .orderBy(sql`${table.createdAt} desc`);
    return rows.map(mapDelivery);
  });
}

/** The Slack person an Opengeni identity linked through one installation, if any. */
export async function findSlackBotUserLinkForSubject(
  db: Database,
  home: SlackAgentUpdateHome,
  input: { connectionId: string; subjectId: string },
): Promise<{ slackUserId: string; updatesMutedAt: Date | null } | null> {
  return await withRlsContext(db, home, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        slackUserId: schema.slackBotUserLinks.slackUserId,
        updatesMutedAt: schema.slackBotUserLinks.updatesMutedAt,
      })
      .from(schema.slackBotUserLinks)
      .where(
        and(
          eq(schema.slackBotUserLinks.workspaceId, home.workspaceId),
          eq(schema.slackBotUserLinks.connectionId, input.connectionId),
          eq(schema.slackBotUserLinks.subjectId, input.subjectId),
        ),
      )
      .orderBy(sql`${schema.slackBotUserLinks.updatedAt} desc`)
      .limit(1);
    return row ?? null;
  });
}
