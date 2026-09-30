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

/** Capture is independent of terminal observation and remains valid after the
 * launching attempt ends. Only an exact retained process/background command in
 * this session is eligible; this helper never creates command authority. */
export async function appendSessionCommandOutput(
  db: Database,
  input: SessionCommandOutputInput,
): Promise<SessionEvent[]> {
  if (!input.chunkId || input.chunkId.length > 200)
    throw new Error("Invalid command output chunk ID");
  if (!input.chunk) return [];
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
    // A provider page can hold megabytes. Read and write its parts in one
    // statement each so the session event lock is held briefly.
    const parts: Array<{ clientEventId: string; chunk: string }> = [];
    for (let offset = 0, part = 0; offset < input.chunk.length; part++) {
      let end = Math.min(offset + 16_384, input.chunk.length);
      if (end < input.chunk.length && /[\uD800-\uDBFF]/u.test(input.chunk[end - 1]!)) end -= 1;
      parts.push({
        clientEventId: `command-output:${input.commandId}:${input.chunkId}:${input.stream}:${part}`,
        chunk: input.chunk.slice(offset, end),
      });
      offset = end;
    }
    const existing = new Map(
      (
        await tx
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
                parts.map((part) => part.clientEventId),
              ),
            ),
          )
      ).map((row) => [row.clientEventId, row]),
    );
    const missing = parts.filter((part) => {
      const row = existing.get(part.clientEventId);
      if (!row) return true;
      const payload = fromPostgresLosslessJson(row.payload, row.version) as Record<string, unknown>;
      if (
        payload.chunk !== part.chunk ||
        payload.commandId !== input.commandId ||
        payload.stream !== input.stream
      ) {
        throw new Error("Command output retry changed the captured chunk");
      }
      return false;
    });
    let sequence = session.lastSequence;
    const inserted = missing.length
      ? await tx
          .insert(schema.sessionEvents)
          .values(
            missing.map((part) =>
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
                    stream: input.stream,
                    streamFidelity: input.streamFidelity ?? "separate",
                    chunk: part.chunk,
                  },
                },
                "payload",
                "payloadCodecVersion",
              ),
            ),
          )
          .returning()
      : [];
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
