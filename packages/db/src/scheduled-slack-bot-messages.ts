import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/** Immutable bot message intent saved by one scheduled run for its task's fixed channel. */
export type ScheduledSlackBotMessage = {
  id: string;
  scheduledTaskId: string;
  connectionId: string;
  connectionVersion: number;
  channelId: string;
  threadTimestamp: string | null;
  text: string;
};

type ScheduledSlackBotMessageScope = { accountId: string; workspaceId: string; sessionId: string };

/**
 * The database refused to save or read a message: the session is not this
 * task's scheduler run, the task no longer names this bot and channel, or the
 * bot connection changed. The message is the database's short reason.
 */
export class ScheduledSlackBotMessageRefusedError extends Error {
  override readonly name = "ScheduledSlackBotMessageRefusedError";
}

function refusal(error: unknown): ScheduledSlackBotMessageRefusedError | null {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === "42501" &&
      typeof (current as { message?: unknown }).message === "string"
    ) {
      return new ScheduledSlackBotMessageRefusedError((current as { message: string }).message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

async function refusingWith<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw refusal(error) ?? error;
  }
}

/**
 * Save one message for a scheduled run. Call only after authorizing this exact
 * session and resolving its live bot connection. The database re-proves that
 * the session is the scheduler-created run of `scheduledTaskId`, that the task
 * still names this bot and channel, and that the connection is the same active
 * version, then returns the server-owned id that also becomes the Slack post
 * operation id.
 */
export async function prepareScheduledSlackBotMessage(
  db: Database,
  input: ScheduledSlackBotMessageScope & Omit<ScheduledSlackBotMessage, "id">,
): Promise<ScheduledSlackBotMessage> {
  const rows = await refusingWith(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (tx) =>
      rawRows<{ id: string }>(
        tx,
        sql`select opengeni_private.prepare_scheduled_slack_bot_message(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
          ${input.scheduledTaskId}::uuid, ${input.connectionId}::uuid,
          ${input.connectionVersion}::integer, ${input.channelId}::text,
          ${input.threadTimestamp}::text, ${input.text}::text
        ) as id`,
      ),
    ),
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Scheduled Slack message was not saved");
  return {
    id,
    scheduledTaskId: input.scheduledTaskId,
    connectionId: input.connectionId,
    connectionVersion: input.connectionVersion,
    channelId: input.channelId,
    threadTimestamp: input.threadTimestamp,
    text: input.text,
  };
}

/** Read one prepared message, only from the session that prepared it. */
export async function readScheduledSlackBotMessage(
  db: Database,
  input: ScheduledSlackBotMessageScope & { id: string },
): Promise<ScheduledSlackBotMessage | null> {
  const rows = await refusingWith(() =>
    withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (tx) =>
      rawRows<{
        id: string;
        scheduled_task_id: string;
        connection_id: string;
        connection_version: number;
        channel_id: string;
        thread_timestamp: string | null;
        message_text: string;
      }>(
        tx,
        sql`select * from opengeni_private.read_scheduled_slack_bot_message(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
          ${input.id}::uuid
        )`,
      ),
    ),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scheduledTaskId: row.scheduled_task_id,
    connectionId: row.connection_id,
    connectionVersion: Number(row.connection_version),
    channelId: row.channel_id,
    threadTimestamp: row.thread_timestamp,
    text: row.message_text,
  };
}
