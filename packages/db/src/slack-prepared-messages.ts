import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

export type PreparedSlackMessage = {
  id: string;
  connectionId: string;
  connectionVersion: number;
  targetKind: "channel" | "user";
  targetId: string;
  threadTimestamp: string | null;
  text: string;
};
type Scope = { accountId: string; workspaceId: string; sessionId: string };

/** Call only after authorizing this exact session and its live bot connection. */
export async function prepareSlackMessage(
  db: Database,
  input: Scope & Omit<PreparedSlackMessage, "id">,
): Promise<PreparedSlackMessage> {
  return await withRlsContext(db, input, async (tx) => {
    const rows = await rawRows<PreparedSlackMessage>(
      tx,
      sql`
      INSERT INTO slack_prepared_messages
        (account_id, workspace_id, session_id, connection_id, connection_version, target_kind, target_id, thread_timestamp, message_text)
      SELECT ${input.accountId}::uuid, ${input.workspaceId}::uuid, s.id, c.id, c.version,
        ${input.targetKind}, ${input.targetId}, ${input.threadTimestamp}, ${input.text}
      FROM sessions s JOIN connections c ON c.account_id = s.account_id AND c.workspace_id = s.workspace_id
      WHERE s.id = ${input.sessionId}::uuid AND s.account_id = ${input.accountId}::uuid
        AND s.workspace_id = ${input.workspaceId}::uuid AND c.id = ${input.connectionId}::uuid
        AND c.version = ${input.connectionVersion} AND c.subject_id IS NULL
        AND c.kind = 'app_install' AND c.provider_domain = 'slack.com' AND c.status = 'active'
      RETURNING id, connection_id AS "connectionId", connection_version AS "connectionVersion",
        target_kind AS "targetKind", target_id AS "targetId", thread_timestamp AS "threadTimestamp", message_text AS text
    `,
    );
    if (!rows[0]) throw new Error("Slack message connection or session is unavailable");
    return rows[0];
  });
}

export async function getPreparedSlackMessage(
  db: Database,
  input: Scope & { id: string },
): Promise<PreparedSlackMessage | null> {
  return await withRlsContext(db, input, async (tx) => {
    const rows = await rawRows<PreparedSlackMessage>(
      tx,
      sql`
      SELECT id, connection_id AS "connectionId", connection_version AS "connectionVersion",
        target_kind AS "targetKind", target_id AS "targetId", thread_timestamp AS "threadTimestamp", message_text AS text
      FROM slack_prepared_messages WHERE account_id = ${input.accountId}::uuid
        AND workspace_id = ${input.workspaceId}::uuid AND session_id = ${input.sessionId}::uuid AND id = ${input.id}::uuid
    `,
    );
    return rows[0] ?? null;
  });
}
