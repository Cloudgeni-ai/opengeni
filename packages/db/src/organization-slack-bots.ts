import type { EventSourceStatus } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { getConnectionMetadata, listConnectionsMetadata } from "./connection-metadata";
import { nestedPostgresSqlState } from "./persistence-errors";

export type SlackBotAccess = {
  connectionId: string;
  homeWorkspaceId: string;
  generation: number;
  connectionVersion: number;
};

/** Configured sharing is independent of whether the bot needs reconnect. */
export async function readOrganizationSlackBotAccess(
  db: Database,
  scope: { accountId: string; workspaceId: string; connectionId: string },
) {
  const rows = await withRlsContext(db, scope, async (tx) =>
    rawRows<{
      enabled: boolean;
      generation: number;
      workspace_ids: string[] | null;
    }>(
      tx,
      sql`select * from opengeni_private.read_slack_bot_workspace_access(${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${scope.connectionId}::uuid)`,
    ),
  );
  if (!rows[0]) throw new Error("Slack bot access is unavailable");
  return {
    enabled: rows[0].enabled,
    generation: Number(rows[0].generation),
    workspaceIds: rows[0].workspace_ids,
  };
}

/** Metadata discovery only. The adapter must first authorize connections:read
 * in this exact target workspace. This never returns credentials or personal rows. */
export async function sharedOrganizationSlackBots(
  db: Database,
  scope: { accountId: string; workspaceId: string },
): Promise<SlackBotAccess[]> {
  return withRlsContext(db, scope, async (tx) => {
    const rows = await rawRows<{
      connection_id: string;
      home_workspace_id: string;
      generation: number;
      connection_version: number;
    }>(
      tx,
      sql`select * from opengeni_private.list_organization_slack_bots(${scope.accountId}::uuid, ${scope.workspaceId}::uuid)`,
    );
    return rows.map((row) => ({
      connectionId: row.connection_id,
      homeWorkspaceId: row.home_workspace_id,
      generation: Number(row.generation),
      connectionVersion: row.connection_version,
    }));
  });
}

export async function availableSlackBotConnectionMetadata(
  db: Database,
  scope: { accountId: string; workspaceId: string },
) {
  const local = (await listConnectionsMetadata(db, scope.workspaceId, null)).filter(
    (row) =>
      row.accountId === scope.accountId &&
      row.providerDomain === "slack.com" &&
      row.kind === "app_install" &&
      row.subjectId === null,
  );
  const shares = await sharedOrganizationSlackBots(db, scope);
  const shared = await Promise.all(
    shares
      .filter((share) => !local.some((row) => row.id === share.connectionId))
      .map(async (share) => {
        const row = await getConnectionMetadata(
          db,
          share.homeWorkspaceId,
          share.connectionId,
          null,
        );
        return row?.accountId === scope.accountId
          ? {
              ...row,
              metadata: {
                ...row.metadata,
                organizationSharingGeneration: share.generation,
              },
            }
          : null;
      }),
  );
  return [...local, ...shared.filter((row) => row !== null)];
}

/** A shared workspace's Slack source, with what recording a delivery into it needs. */
export type SharedSlackEventSource = {
  workspaceId: string;
  sourceId: string;
  status: EventSourceStatus;
  statusReason: string | null;
};

export const SHARED_SLACK_EVENT_SOURCES_V2_ROUTINE =
  "opengeni_private.list_shared_slack_event_sources_v2(uuid, uuid, uuid, text)";

/** A withheld definer is rechecked at most once a minute; once granted it stays so. */
const V2_RECHECK_MS = 60_000;
const v2Granted = new WeakMap<Database, { value: boolean; at: number }>();

async function sharedSlackLookupV2Granted(db: Database, now: number): Promise<boolean> {
  const cached = v2Granted.get(db);
  if (cached && (cached.value || now - cached.at < V2_RECHECK_MS)) return cached.value;
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select coalesce(pg_catalog.has_function_privilege(
      pg_catalog.to_regprocedure(${SHARED_SLACK_EVENT_SOURCES_V2_ROUTINE}), 'EXECUTE'), false) as granted`,
  );
  const value = row?.granted === true;
  v2Granted.set(db, { value, at: now });
  return value;
}

/**
 * The Slack event sources, for one Slack team, of the other workspaces the
 * organization currently shares this home bot with. Empty unless the bot is
 * the active verified install and its sharing is enabled; the saved workspace
 * allowlist applies. In one statement, with each source's status, so
 * recording needs no further read. Once the runtime may call 1552's definer it
 * is one indexed lookup whatever the organization's size; until then 1538's
 * routine probes each covered workspace.
 */
export async function sharedSlackEventSources(
  db: Database,
  scope: {
    accountId: string;
    homeWorkspaceId: string;
    connectionId: string;
    externalKey: string;
  },
): Promise<SharedSlackEventSource[]> {
  const read = (v2: boolean) =>
    withRlsContext(
      db,
      { accountId: scope.accountId, workspaceId: scope.homeWorkspaceId },
      async (tx) =>
        rawRows<{
          workspace_id: string;
          source_id: string;
          status: EventSourceStatus;
          status_reason: string | null;
        }>(
          tx,
          v2
            ? sql`select workspace_id, source_id, status, status_reason
            from opengeni_private.list_shared_slack_event_sources_v2(
              ${scope.accountId}::uuid, ${scope.homeWorkspaceId}::uuid, ${scope.connectionId}::uuid,
              ${scope.externalKey}::text)`
            : sql`select workspace_id, source_id, status, status_reason
            from opengeni_private.list_shared_slack_event_sources_v1(
              ${scope.accountId}::uuid, ${scope.homeWorkspaceId}::uuid, ${scope.connectionId}::uuid,
              ${scope.externalKey}::text)`,
        ),
    );
  let rows: Awaited<ReturnType<typeof read>>;
  if (await sharedSlackLookupV2Granted(db, Date.now())) {
    try {
      rows = await read(true);
    } catch (error) {
      // EXECUTE revoked or the routine gone: back to v1 until the next check.
      // v2's own scope refusal (also 42501) is v1's answer too, so it stands.
      const state = nestedPostgresSqlState(error);
      const cause = error instanceof Error ? error.cause : undefined;
      const refusedScope = /scope mismatch/iu.test(`${String(error)} ${String(cause ?? "")}`);
      if ((state !== "42501" && state !== "42883") || refusedScope) throw error;
      v2Granted.set(db, { value: false, at: Date.now() });
      rows = await read(false);
    }
  } else {
    rows = await read(false);
  }
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    status: row.status,
    statusReason: row.status_reason,
  }));
}

/**
 * Whether the workspace has an Opengeni Slack bot to use, in one statement:
 * an active install here verified at its current version, or one its
 * organization shares with it (the share function applies the same checks
 * to the bot in its home workspace). Metadata only; never reads credentials.
 */
export async function hasAvailableSlackBot(
  db: Database,
  scope: { accountId: string; workspaceId: string },
): Promise<boolean> {
  const rows = await withRlsContext(db, scope, async (tx) =>
    rawRows<{ available: boolean }>(
      tx,
      sql`
      select exists (
        select 1 from connections c
        where c.account_id = ${scope.accountId}::uuid
          and c.workspace_id = ${scope.workspaceId}::uuid
          and c.subject_id is null and c.kind = 'app_install' and c.provider_domain = 'slack.com'
          and c.metadata->>'credentialRole' = 'opengeni_slack_bot' and c.status = 'active'
          and c.verified_install_at is not null and c.verified_install_version = c.version
      ) or exists (
        select 1 from opengeni_private.list_organization_slack_bots(
          ${scope.accountId}::uuid, ${scope.workspaceId}::uuid)
      ) as available`,
    ),
  );
  return rows[0]?.available === true;
}

/** Canonical organization-administrator authentication is supplied by a trusted
 * HTTP adapter. SQL separately rechecks live authority and exact bot identity. */
export async function setOrganizationSlackBotAccess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    enabled: boolean;
    workspaceIds?: string[] | null;
  },
  authorize: () => Promise<{ accountId: string; subjectId: string }>,
): Promise<{
  enabled: boolean;
  generation: number;
  workspaceIds: string[] | null;
}> {
  const actor = await authorize();
  if (actor.accountId !== input.accountId || !actor.subjectId)
    throw new Error("Organization administrator required");
  return withRlsContext(db, input, async (tx) => {
    const [previous] = await rawRows<{ subject: string | null }>(
      tx,
      sql`select current_setting('opengeni.subject_id', true) as subject`,
    );
    await setSubjectRlsContext(tx, actor.subjectId);
    if (input.workspaceIds === undefined) {
      // Legacy clients change the on/off setting only. Omission must never
      // expand a previously selected set to the entire organization.
      await tx.execute(sql`select * from opengeni_private.set_organization_slack_bot_access(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.connectionId}::uuid,
        ${actor.subjectId}::text, ${input.enabled}::boolean)`);
      const result = await readOrganizationSlackBotAccess(tx, input);
      await tx.execute(
        sql`select set_config('opengeni.subject_id', ${previous?.subject ?? ""}, true)`,
      );
      return result;
    }
    const rows = await rawRows<{
      enabled: boolean;
      generation: number;
      workspace_ids: string[] | null;
    }>(
      tx,
      sql`
      select * from opengeni_private.set_slack_bot_workspace_access(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.connectionId}::uuid,
        ${actor.subjectId}::text, ${input.enabled}::boolean, ${
          input.workspaceIds === null
            ? sql`null::uuid[]`
            : sql`ARRAY[${sql.join(
                input.workspaceIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}]::uuid[]`
        }
      )`,
    );
    if (!rows[0]) throw new Error("Slack bot access was not saved");
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${previous?.subject ?? ""}, true)`,
    );
    return {
      enabled: rows[0].enabled,
      generation: Number(rows[0].generation),
      workspaceIds: rows[0].workspace_ids,
    };
  });
}

export type PreparedBotMessage = {
  id: string;
  scheduledTaskId: string | null;
  connectionId: string;
  connectionVersion: number;
  homeWorkspaceId: string;
  sharingGeneration: number;
  channelId: string;
  threadTimestamp: string | null;
  text: string;
};
type MessageScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
};

export async function prepareBotMessage(
  db: Database,
  input: MessageScope & Omit<PreparedBotMessage, "id">,
): Promise<PreparedBotMessage> {
  const rows = await withRlsContext(db, input, async (tx) =>
    rawRows<{ id: string }>(
      tx,
      sql`
    select opengeni_private.prepare_organization_slack_bot_message(
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
      ${input.scheduledTaskId}::uuid, ${input.connectionId}::uuid, ${input.connectionVersion}::integer,
      ${input.homeWorkspaceId}::uuid, ${input.sharingGeneration}::bigint,
      ${input.channelId}::text, ${input.threadTimestamp}::text, ${input.text}::text
    ) as id`,
    ),
  );
  if (!rows[0]?.id) throw new Error("Slack message was not prepared");
  return { ...input, id: rows[0].id };
}

export async function readPreparedBotMessage(
  db: Database,
  input: MessageScope & { id: string },
): Promise<PreparedBotMessage | null> {
  const rows = await withRlsContext(db, input, async (tx) =>
    rawRows<{
      id: string;
      scheduled_task_id: string | null;
      connection_id: string;
      connection_version: number;
      home_workspace_id: string;
      sharing_generation: number;
      channel_id: string;
      thread_timestamp: string | null;
      message_text: string;
    }>(
      tx,
      sql`select * from opengeni_private.read_organization_slack_bot_message(
    ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid, ${input.id}::uuid)`,
    ),
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        scheduledTaskId: row.scheduled_task_id,
        connectionId: row.connection_id,
        connectionVersion: row.connection_version,
        homeWorkspaceId: row.home_workspace_id,
        sharingGeneration: Number(row.sharing_generation),
        channelId: row.channel_id,
        threadTimestamp: row.thread_timestamp,
        text: row.message_text,
      }
    : null;
}
