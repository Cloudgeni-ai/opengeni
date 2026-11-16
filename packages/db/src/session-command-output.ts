import { and, eq, inArray } from "drizzle-orm";
import type { SessionEvent } from "@opengeni/contracts";
import type { Database } from "./database";
import { withSessionActivityRlsContext } from "./database";
import { lockSessionEventWriteRows } from "./session-control";
import { fromPostgresLosslessJson, withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";

export type SessionCommandOutputInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  commandId: string;
  /** Stable identity of this consumed provider chunk, reused on persistence retry. */
  chunkId: string;
  stream: "stdout" | "stderr";
  streamFidelity?: "separate" | "merged";
  chunk: string;
};

/** Every output chunk of a command carries a client event id with this prefix.
 * Readers bound their scan by it (byte order), so it must never change. */
export function commandOutputClientEventIdPrefix(commandId: string) {
  return `command-output:${commandId}:`;
}

/** Frames stored per transaction by a connected capture: a statement-size
 * bound, so one transaction's parameters stay well within PostgreSQL's limit
 * while a replay of thousands of frames takes a few transactions, not one each. */
export const CONNECTED_COMMAND_OUTPUT_FRAMES_PER_TRANSACTION = 256;

/** One provider-frame identity scheme for attached reads, push and reconciliation. */
export function createConnectedCommandOutputCapture(
  db: Database,
  ids: { accountId: string; workspaceId: string; sessionId: string },
  publish?: (events: SessionEvent[]) => Promise<void>,
) {
  return async (
    commandId: string,
    frames: Array<{ sequence: string; stream: "stdout" | "stderr"; chunk: string }>,
  ) => {
    for (
      let start = 0;
      start < frames.length;
      start += CONNECTED_COMMAND_OUTPUT_FRAMES_PER_TRANSACTION
    ) {
      const events = await appendSessionCommandOutputs(
        db,
        frames
          .slice(start, start + CONNECTED_COMMAND_OUTPUT_FRAMES_PER_TRANSACTION)
          .map((frame) => ({
            ...ids,
            commandId,
            chunkId: `op-frame:${frame.sequence}`,
            stream: frame.stream,
            chunk: frame.chunk,
          })),
      );
      if (events.length) await publish?.(events).catch(() => undefined);
    }
  };
}

/** Capture is independent of terminal observation and remains valid after the
 * launching attempt ends. Only an exact retained process/background command in
 * this session is eligible; this helper never creates command authority. */
export async function appendSessionCommandOutput(
  db: Database,
  input: SessionCommandOutputInput,
): Promise<SessionEvent[]> {
  return await appendSessionCommandOutputs(db, [input]);
}

/** Parts read or written per statement: keeps each statement's parameters
 * well within PostgreSQL's limit however large a batch's chunks are. */
const COMMAND_OUTPUT_PARTS_PER_STATEMENT = 1_000;

/** Store several chunks of ONE command, in order, in one transaction. Each
 * chunk keeps its own identity and is idempotent exactly as when stored
 * alone; storing a batch only saves the transaction and lock per chunk. */
export async function appendSessionCommandOutputs(
  db: Database,
  inputs: readonly SessionCommandOutputInput[],
): Promise<SessionEvent[]> {
  const input = inputs[0];
  if (!input) return [];
  for (const each of inputs) {
    if (!each.chunkId || each.chunkId.length > 200)
      throw new Error("Invalid command output chunk ID");
    if (
      each.accountId !== input.accountId ||
      each.workspaceId !== input.workspaceId ||
      each.sessionId !== input.sessionId ||
      each.commandId !== input.commandId
    )
      throw new Error("A command output batch belongs to one command");
  }
  const chunks = inputs.filter((each) => each.chunk);
  if (!chunks.length) return [];
  return await withSessionActivityRlsContext(db, input, async (tx) => {
    const events: SessionEvent[] = [];
    const locks = await lockSessionEventWriteRows(tx, {
      workspaceId: input.workspaceId,
      controlLock: "share",
      sessionIds: [input.sessionId],
    });
    const session = locks.sessions[0];
    if (!session || session.accountId !== input.accountId)
      throw new Error("Command output session not found");
    const [command] = await tx
      .select({ id: schema.sessionBackgroundCommands.id })
      .from(schema.sessionBackgroundCommands)
      .where(
        and(
          eq(schema.sessionBackgroundCommands.accountId, input.accountId),
          eq(schema.sessionBackgroundCommands.workspaceId, input.workspaceId),
          eq(schema.sessionBackgroundCommands.sessionId, input.sessionId),
          eq(schema.sessionBackgroundCommands.id, input.commandId),
        ),
      )
      .limit(1);
    if (!command) {
      const [process] = await tx
        .select({ id: schema.sandboxRetainedProcesses.id })
        .from(schema.sandboxRetainedProcesses)
        .where(
          and(
            eq(schema.sandboxRetainedProcesses.accountId, input.accountId),
            eq(schema.sandboxRetainedProcesses.workspaceId, input.workspaceId),
            eq(schema.sandboxRetainedProcesses.sessionId, input.sessionId),
            eq(schema.sandboxRetainedProcesses.id, input.commandId),
          ),
        )
        .limit(1);
      if (!process) throw new Error("Command output has no retained command identity");
    }
    // A provider page can hold megabytes. Read and write its parts a
    // statement at a time so the session event lock is held briefly.
    const parts: Array<{
      clientEventId: string;
      chunk: string;
      stream: "stdout" | "stderr";
      streamFidelity: "separate" | "merged";
    }> = [];
    for (const each of chunks) {
      for (let offset = 0, part = 0; offset < each.chunk.length; part++) {
        let end = Math.min(offset + 16_384, each.chunk.length);
        if (end < each.chunk.length && /[\uD800-\uDBFF]/u.test(each.chunk[end - 1]!)) end -= 1;
        parts.push({
          clientEventId: `${commandOutputClientEventIdPrefix(each.commandId)}${each.chunkId}:${each.stream}:${part}`,
          chunk: each.chunk.slice(offset, end),
          stream: each.stream,
          streamFidelity: each.streamFidelity ?? "separate",
        });
        offset = end;
      }
    }
    const existing = new Map<
      string,
      {
        payload: unknown;
        version: (typeof schema.sessionEvents.$inferSelect)["payloadCodecVersion"];
      }
    >();
    for (let start = 0; start < parts.length; start += COMMAND_OUTPUT_PARTS_PER_STATEMENT) {
      const rows = await tx
        .select({
          clientEventId: schema.sessionEvents.clientEventId,
          payload: schema.sessionEvents.payload,
          version: schema.sessionEvents.payloadCodecVersion,
        })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            inArray(
              schema.sessionEvents.clientEventId,
              parts
                .slice(start, start + COMMAND_OUTPUT_PARTS_PER_STATEMENT)
                .map((part) => part.clientEventId),
            ),
          ),
        );
      for (const row of rows) if (row.clientEventId) existing.set(row.clientEventId, row);
    }
    const missing = parts.filter((part) => {
      const row = existing.get(part.clientEventId);
      if (!row) return true;
      const payload = fromPostgresLosslessJson(row.payload, row.version) as Record<string, unknown>;
      if (
        payload.chunk !== part.chunk ||
        payload.commandId !== input.commandId ||
        payload.stream !== part.stream
      ) {
        throw new Error("Command output retry changed the captured chunk");
      }
      return false;
    });
    let sequence = session.lastSequence;
    const inserted: Array<typeof schema.sessionEvents.$inferSelect> = [];
    for (let start = 0; start < missing.length; start += COMMAND_OUTPUT_PARTS_PER_STATEMENT) {
      inserted.push(
        ...(await tx
          .insert(schema.sessionEvents)
          .values(
            missing.slice(start, start + COMMAND_OUTPUT_PARTS_PER_STATEMENT).map((part) =>
              withLosslessContentWriteVersion(
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "sandbox.command.output.delta",
                  clientEventId: part.clientEventId,
                  payload: {
                    commandId: input.commandId,
                    stream: part.stream,
                    streamFidelity: part.streamFidelity,
                    chunk: part.chunk,
                  },
                },
                "payload",
                "payloadCodecVersion",
              ),
            ),
          )
          .returning()),
      );
    }
    for (const row of inserted.sort((a, b) => a.sequence - b.sequence))
      events.push({
        id: row.id,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sequence: row.sequence,
        type: "sandbox.command.output.delta",
        payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
        occurredAt: row.occurredAt.toISOString(),
        clientEventId: row.clientEventId,
        turnId: null,
        turnGeneration: null,
        turnAttemptId: null,
        turnAssociation: null,
        duplicateOfEventId: null,
        duplicateReason: null,
      });
    if (sequence !== session.lastSequence) {
      await tx
        .update(schema.sessions)
        .set({ lastSequence: sequence })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
    }
    return events;
  });
}
