import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { getConnectionMetadata, listConnectionsMetadata } from "./index";

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
    rawRows<{ enabled: boolean; generation: number }>(
      tx,
      sql`select * from opengeni_private.read_organization_slack_bot_access(${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${scope.connectionId}::uuid)`,
    ),
  );
  if (!rows[0]) throw new Error("Slack bot access is unavailable");
  return { enabled: rows[0].enabled, generation: Number(rows[0].generation) };
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
              metadata: { ...row.metadata, organizationSharingGeneration: share.generation },
            }
          : null;
      }),
  );
  return [...local, ...shared.filter((row) => row !== null)];
}

/** Canonical organization-administrator authentication is supplied by a trusted
 * HTTP adapter. SQL separately rechecks live authority and exact bot identity. */
export async function setOrganizationSlackBotAccess(
  db: Database,
  input: { accountId: string; workspaceId: string; connectionId: string; enabled: boolean },
  authorize: () => Promise<{ accountId: string; subjectId: string }>,
): Promise<{ enabled: boolean; generation: number }> {
  const actor = await authorize();
  if (actor.accountId !== input.accountId || !actor.subjectId)
    throw new Error("Organization administrator required");
  return withRlsContext(db, input, async (tx) => {
    const [previous] = await rawRows<{ subject: string | null }>(
      tx,
      sql`select current_setting('opengeni.subject_id', true) as subject`,
    );
    await setSubjectRlsContext(tx, actor.subjectId);
    const rows = await rawRows<{ enabled: boolean; generation: number }>(
      tx,
      sql`
      select * from opengeni_private.set_organization_slack_bot_access(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.connectionId}::uuid,
        ${actor.subjectId}::text, ${input.enabled}::boolean
      )`,
    );
    if (!rows[0]) throw new Error("Slack bot access was not saved");
    await tx.execute(
      sql`select set_config('opengeni.subject_id', ${previous?.subject ?? ""}, true)`,
    );
    return { enabled: rows[0].enabled, generation: Number(rows[0].generation) };
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
type MessageScope = { accountId: string; workspaceId: string; sessionId: string };

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
