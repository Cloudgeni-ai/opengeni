import { and, eq } from "drizzle-orm";
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
    let sequence = session.lastSequence;
    let part = 0;
    for (let offset = 0; offset < input.chunk.length;) {
      let end = Math.min(offset + 16_384, input.chunk.length);
      if (end < input.chunk.length && /[\uD800-\uDBFF]/u.test(input.chunk[end - 1]!)) end -= 1;
      const clientEventId = `command-output:${input.commandId}:${input.chunkId}:${input.stream}:${part++}`;
      const chunk = input.chunk.slice(offset, end);
      offset = end;
      const [existing] = await tx
        .select({
          payload: schema.sessionEvents.payload,
          version: schema.sessionEvents.payloadCodecVersion,
        })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.clientEventId, clientEventId),
          ),
        )
        .limit(1);
      if (existing) {
        const payload = fromPostgresLosslessJson(existing.payload, existing.version) as Record<
          string,
          unknown
        >;
        if (
          payload.chunk !== chunk ||
          payload.commandId !== input.commandId ||
          payload.stream !== input.stream
        ) {
          throw new Error("Command output retry changed the captured chunk");
        }
        continue;
      }
      const [inserted] = await tx
        .insert(schema.sessionEvents)
        .values(
          withLosslessContentWriteVersion(
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "sandbox.command.output.delta",
              clientEventId,
              payload: {
                commandId: input.commandId,
                stream: input.stream,
                streamFidelity: input.streamFidelity ?? "separate",
                chunk,
              },
            },
            "payload",
            "payloadCodecVersion",
          ),
        )
        .returning();
      if (inserted)
        events.push({
          id: inserted.id,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence: inserted.sequence,
          type: "sandbox.command.output.delta",
          payload: fromPostgresLosslessJson(inserted.payload, inserted.payloadCodecVersion),
          occurredAt: inserted.occurredAt.toISOString(),
          clientEventId,
          turnId: null,
          turnGeneration: null,
          turnAttemptId: null,
          turnAssociation: null,
          duplicateOfEventId: null,
          duplicateReason: null,
        });
    }
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
