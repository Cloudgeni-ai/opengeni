import {
  MODEL_CONTEXT_SNAPSHOT_MAX_UTF8_BYTES,
  ModelContextSnapshot,
  SessionModelContextResponse,
} from "@opengeni/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext } from "./database";
import * as schema from "./schema";

export class ModelContextSnapshotAuthorityError extends Error {
  readonly code = "model_context_snapshot_authority_mismatch";

  constructor() {
    super("Model context snapshot does not match the exact durable execution attempt");
    this.name = "ModelContextSnapshotAuthorityError";
  }
}

export async function persistModelContextSnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
    snapshot: ModelContextSnapshot;
  },
): Promise<void> {
  const snapshot = ModelContextSnapshot.parse(input.snapshot);
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MODEL_CONTEXT_SNAPSHOT_MAX_UTF8_BYTES) {
    throw new RangeError("Model context snapshot exceeds the 16 MiB persist limit");
  }
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [attempt] = await tx
          .select({
            accountId: schema.sessionTurnAttempts.accountId,
            workspaceId: schema.sessionTurnAttempts.workspaceId,
            sessionId: schema.sessionTurnAttempts.sessionId,
            turnId: schema.sessionTurnAttempts.turnId,
            executionGeneration: schema.sessionTurnAttempts.executionGeneration,
          })
          .from(schema.sessionTurnAttempts)
          .where(
            and(
              eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
              eq(schema.sessionTurnAttempts.id, input.attemptId),
            ),
          )
          .limit(1);
        if (
          !attempt ||
          attempt.accountId !== input.accountId ||
          attempt.sessionId !== input.sessionId ||
          attempt.turnId !== input.turnId ||
          attempt.executionGeneration !== input.executionGeneration
        ) {
          throw new ModelContextSnapshotAuthorityError();
        }

        const now = new Date(snapshot.capturedAt);
        await tx
          .insert(schema.sessionAttemptModelContextSnapshots)
          .values({
            attemptId: input.attemptId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            executionGeneration: input.executionGeneration,
            requestIndex: snapshot.requestIndex,
            capturedAt: now,
            snapshot,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.sessionAttemptModelContextSnapshots.attemptId,
            set: {
              requestIndex: snapshot.requestIndex,
              capturedAt: now,
              snapshot,
              updatedAt: now,
            },
            setWhere: sql`${schema.sessionAttemptModelContextSnapshots.requestIndex} <= ${snapshot.requestIndex}`,
          });
      }),
  );
}

export async function getLatestSessionModelContext(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<SessionModelContextResponse> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select({
          attemptId: schema.sessionAttemptModelContextSnapshots.attemptId,
          turnId: schema.sessionAttemptModelContextSnapshots.turnId,
          snapshot: schema.sessionAttemptModelContextSnapshots.snapshot,
        })
        .from(schema.sessionAttemptModelContextSnapshots)
        .where(
          and(
            eq(schema.sessionAttemptModelContextSnapshots.workspaceId, input.workspaceId),
            eq(schema.sessionAttemptModelContextSnapshots.sessionId, input.sessionId),
          ),
        )
        .orderBy(
          desc(schema.sessionAttemptModelContextSnapshots.capturedAt),
          desc(schema.sessionAttemptModelContextSnapshots.requestIndex),
        )
        .limit(1);
      if (!row) {
        return {
          sessionId: input.sessionId,
          attemptId: null,
          turnId: null,
          snapshot: null,
        };
      }
      return {
        sessionId: input.sessionId,
        attemptId: row.attemptId,
        turnId: row.turnId,
        snapshot: ModelContextSnapshot.parse(row.snapshot),
      };
    },
  );
}
