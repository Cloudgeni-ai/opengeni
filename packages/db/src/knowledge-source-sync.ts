import {
  type FileAsset,
  KnowledgeSourceSyncAction,
  KnowledgeSourceSyncRunSummary,
  type ScheduledTask,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { setSubjectRlsContext, withRlsContext } from "./database";
import { recordKnowledgeLifecycleEvent } from "./scoped-knowledge";
import * as schema from "./schema";

export type KnowledgeSourceSyncState = {
  sourceId: string;
  scheduledTaskId: string;
  sourceSyncGeneration: number;
  sourceConfigGeneration: number;
  sourceLifecycleGeneration: number;
  executionCheckpoint: Record<string, unknown> | null;
  executionCheckpointGeneration: number;
  activeScanGeneration: number;
  providerCursor: Record<string, unknown> | null;
  wakeRevision: number;
  pendingWakeCount: number;
  bufferedWake: boolean;
  bufferedScheduledTaskRunId: string | null;
  reconnectRequired: boolean;
  lastSuccessAt: string | null;
  lastCompletedAt: string | null;
  lastSummary: ReturnType<typeof KnowledgeSourceSyncRunSummary.parse> | null;
};

export async function ensureKnowledgeSourceSyncState(
  db: Database,
  task: ScheduledTask,
): Promise<KnowledgeSourceSyncState> {
  const action = KnowledgeSourceSyncAction.parse(task.action);
  return await withRlsContext(
    db,
    { accountId: task.accountId, workspaceId: task.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.knowledgeSourceSyncStates)
        .values({
          sourceId: action.sourceId,
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          scheduledTaskId: task.id,
          sourceSyncGeneration: action.sourceGeneration,
          sourceLifecycleGeneration: action.sourceLifecycleGeneration,
          sourceConfigGeneration: action.sourceConfigGeneration,
          controlWorkspaceId: action.controlWorkspaceId,
          providerCoordinationKey: action.providerCoordinationKey,
          connectionId: action.connection.connectionId,
          connectionVersion: action.connection.connectionVersion,
          connectionProviderDomain: action.connection.providerDomain,
          connectionKind: action.connection.kind,
          connectionOwnerSubjectId: action.connection.ownerSubjectId,
          initiatingSubjectId: action.initiatingSubjectId,
          destination: action.destination,
        })
        .onConflictDoUpdate({
          target: schema.knowledgeSourceSyncStates.sourceId,
          set: {
            scheduledTaskId: task.id,
            sourceSyncGeneration: sql`greatest(${schema.knowledgeSourceSyncStates.sourceSyncGeneration}, ${action.sourceGeneration})`,
            sourceLifecycleGeneration: sql`greatest(${schema.knowledgeSourceSyncStates.sourceLifecycleGeneration}, ${action.sourceLifecycleGeneration})`,
            sourceConfigGeneration: sql`greatest(${schema.knowledgeSourceSyncStates.sourceConfigGeneration}, ${action.sourceConfigGeneration})`,
            controlWorkspaceId: action.controlWorkspaceId,
            providerCoordinationKey: action.providerCoordinationKey,
            connectionId: action.connection.connectionId,
            connectionVersion: action.connection.connectionVersion,
            connectionProviderDomain: action.connection.providerDomain,
            connectionKind: action.connection.kind,
            connectionOwnerSubjectId: action.connection.ownerSubjectId,
            initiatingSubjectId: action.initiatingSubjectId,
            destination: action.destination,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to persist knowledge source sync state");
      return mapState(row);
    },
  );
}

export async function reconcileKnowledgeSourceSyncLiveGeneration(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    initiatingSubjectId: string;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    liveSourceSyncGeneration: number;
  },
): Promise<KnowledgeSourceSyncState> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await setSubjectRlsContext(tx, input.initiatingSubjectId);
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .for("update")
          .limit(1);
        await tx.execute(sql`
          SELECT knowledge_source_sync_lock_authority(
            ${input.accountId}::uuid,
            ${input.sourceId}::uuid,
            NULL::uuid
          )
        `);
        const [source] = await tx
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, input.sourceId))
          .limit(1);
        if (
          !state ||
          !source ||
          state.leaseId !== input.scheduledTaskRunId ||
          state.initiatingSubjectId !== input.initiatingSubjectId ||
          state.sourceConfigGeneration !== input.sourceConfigGeneration ||
          state.sourceLifecycleGeneration !== input.sourceLifecycleGeneration ||
          source.lifecycleState !== "active" ||
          source.lifecycleGeneration !== input.sourceLifecycleGeneration ||
          source.syncGeneration !== input.liveSourceSyncGeneration ||
          state.sourceSyncGeneration > source.syncGeneration
        ) {
          throw new Error("Knowledge source live sync generation authority changed");
        }
        const [updated] = await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({ sourceSyncGeneration: source.syncGeneration, updatedAt: new Date() })
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .returning();
        if (!updated) throw new Error("Knowledge source sync state generation was not updated");
        return mapState(updated);
      }),
  );
}

export async function recordKnowledgeSourceSyncWake(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskId: string;
    scheduledTaskRunId: string;
    cause: "scheduled" | "manual" | "initial" | "provider_event" | "retry" | "repair";
    producerKey: string;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.knowledgeSourceSyncWakes)
          .values(input)
          .onConflictDoNothing({ target: schema.knowledgeSourceSyncWakes.scheduledTaskRunId })
          .returning({ id: schema.knowledgeSourceSyncWakes.id });
        if (!inserted) return;
        const [state] = await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({
            wakeRevision: sql`${schema.knowledgeSourceSyncStates.wakeRevision} + 1`,
            pendingWakeCount: sql`${schema.knowledgeSourceSyncStates.pendingWakeCount} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId),
              eq(
                schema.knowledgeSourceSyncStates.sourceConfigGeneration,
                input.sourceConfigGeneration,
              ),
              eq(
                schema.knowledgeSourceSyncStates.sourceLifecycleGeneration,
                input.sourceLifecycleGeneration,
              ),
            ),
          )
          .returning({ sourceId: schema.knowledgeSourceSyncStates.sourceId });
        if (!state) throw new Error("Knowledge source changed before wake admission");
      });
    },
  );
}

export async function claimKnowledgeSourceSyncLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    overlapPolicy: "skip" | "buffer_one";
    leaseMs?: number;
  },
): Promise<
  | { action: "claimed"; state: KnowledgeSourceSyncState }
  | { action: "skipped" | "buffered"; state: KnowledgeSourceSyncState }
> {
  const leaseUntil = new Date(Date.now() + (input.leaseMs ?? 120_000));
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [wake] = await tx
          .select({ completedAt: schema.knowledgeSourceSyncWakes.completedAt })
          .from(schema.knowledgeSourceSyncWakes)
          .where(eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId))
          .for("update")
          .limit(1);
        if (!wake || wake.completedAt) {
          await tx
            .update(schema.scheduledTaskRuns)
            .set({ status: "skipped", completedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.scheduledTaskRuns.id, input.scheduledTaskRunId));
          const [state] = await tx
            .select()
            .from(schema.knowledgeSourceSyncStates)
            .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
            .limit(1);
          if (!state) throw new Error("Knowledge source sync state was not found");
          return { action: "skipped" as const, state: mapState(state) };
        }
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .for("update")
          .limit(1);
        if (!state) throw new Error("Knowledge source sync state was not found");
        const leaseLive = state.leaseUntil !== null && state.leaseUntil.getTime() > Date.now();
        if (leaseLive && state.leaseId !== input.scheduledTaskRunId) {
          if (input.overlapPolicy === "skip") {
            await tx
              .update(schema.scheduledTaskRuns)
              .set({ status: "skipped", completedAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.scheduledTaskRuns.id, input.scheduledTaskRunId));
            await tx
              .update(schema.knowledgeSourceSyncWakes)
              .set({ coalesced: true, claimedAt: new Date(), completedAt: new Date() })
              .where(
                eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId),
              );
            await tx
              .update(schema.knowledgeSourceSyncStates)
              .set({
                pendingWakeCount: sql`greatest(${schema.knowledgeSourceSyncStates.pendingWakeCount} - 1, 0)`,
              })
              .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId));
            return { action: "skipped" as const, state: mapState(state) };
          }
          if (state.bufferedScheduledTaskRunId) {
            await tx
              .update(schema.scheduledTaskRuns)
              .set({ status: "skipped", completedAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.scheduledTaskRuns.id, input.scheduledTaskRunId));
            await tx
              .update(schema.knowledgeSourceSyncWakes)
              .set({ coalesced: true, claimedAt: new Date(), completedAt: new Date() })
              .where(
                eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId),
              );
            await tx
              .update(schema.knowledgeSourceSyncStates)
              .set({
                pendingWakeCount: sql`greatest(${schema.knowledgeSourceSyncStates.pendingWakeCount} - 1, 0)`,
              })
              .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId));
            return { action: "skipped" as const, state: mapState(state) };
          }
          const [buffered] = await tx
            .update(schema.knowledgeSourceSyncStates)
            .set({
              bufferedWake: true,
              bufferedScheduledTaskRunId: input.scheduledTaskRunId,
              updatedAt: new Date(),
            })
            .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
            .returning();
          await tx
            .update(schema.knowledgeSourceSyncWakes)
            .set({ coalesced: true })
            .where(
              eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId),
            );
          return { action: "buffered" as const, state: mapState(buffered ?? state) };
        }
        const [claimed] = await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({
            leaseId: input.scheduledTaskRunId,
            leaseUntil,
            bufferedWake: false,
            activeScanGeneration: sql`case
              when ${schema.knowledgeSourceSyncStates.leaseId} = ${input.scheduledTaskRunId}::uuid
                then ${schema.knowledgeSourceSyncStates.activeScanGeneration}
              else ${schema.knowledgeSourceSyncStates.activeScanGeneration} + 1
            end`,
            updatedAt: new Date(),
          })
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .returning();
        if (!claimed) throw new Error("Failed to claim knowledge source sync lease");
        await tx
          .update(schema.knowledgeSourceSyncWakes)
          .set({ claimedAt: new Date() })
          .where(eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId));
        return { action: "claimed" as const, state: mapState(claimed) };
      }),
  );
}

export async function checkpointKnowledgeSourceSync(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    executionCheckpoint: Record<string, unknown>;
  },
): Promise<KnowledgeSourceSyncState> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.knowledgeSourceSyncStates)
        .set({
          executionCheckpoint: input.executionCheckpoint,
          executionCheckpointGeneration: sql`${schema.knowledgeSourceSyncStates.executionCheckpointGeneration} + 1`,
          leaseUntil: new Date(Date.now() + 120_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId),
            eq(schema.knowledgeSourceSyncStates.leaseId, input.scheduledTaskRunId),
            eq(
              schema.knowledgeSourceSyncStates.sourceConfigGeneration,
              input.sourceConfigGeneration,
            ),
            eq(
              schema.knowledgeSourceSyncStates.sourceLifecycleGeneration,
              input.sourceLifecycleGeneration,
            ),
          ),
        )
        .returning();
      if (!row) throw new Error("Knowledge source sync lease changed before checkpoint");
      return mapState(row);
    },
  );
}

export async function settleKnowledgeSourceSyncLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    knowledgeSyncRunId?: string | null;
    status: "succeeded" | "failed";
    summary: ReturnType<typeof KnowledgeSourceSyncRunSummary.parse>;
    error?: string | null;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    sourceSyncGeneration: number;
    completedSourceSyncGeneration?: number | null;
    executionCheckpoint?: Record<string, unknown> | null;
  },
): Promise<{ bufferedWake: boolean; bufferedScheduledTaskRunId: string | null }> {
  const summary = KnowledgeSourceSyncRunSummary.parse(input.summary);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .for("update")
          .limit(1);
        if (
          !state ||
          state.leaseId !== input.scheduledTaskRunId ||
          state.sourceConfigGeneration !== input.sourceConfigGeneration ||
          state.sourceLifecycleGeneration !== input.sourceLifecycleGeneration
        ) {
          throw new Error("Knowledge source sync lease changed before settlement");
        }
        await setSubjectRlsContext(tx, state.initiatingSubjectId);
        await tx.execute(sql`
          SELECT knowledge_source_sync_lock_authority(
            ${input.accountId}::uuid,
            ${input.sourceId}::uuid,
            NULL::uuid
          )
        `);
        const [source] = await tx
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, input.sourceId))
          .limit(1);
        const expectedSettledGeneration =
          input.status === "succeeded"
            ? input.completedSourceSyncGeneration
            : source?.syncGeneration;
        if (
          !source ||
          expectedSettledGeneration == null ||
          source.syncGeneration !== expectedSettledGeneration ||
          (input.status === "succeeded"
            ? source.lifecycleState !== "active" ||
              source.lifecycleGeneration !== input.sourceLifecycleGeneration ||
              expectedSettledGeneration !== input.sourceSyncGeneration + 1
            : source.syncGeneration < input.sourceSyncGeneration)
        ) {
          throw new Error("Knowledge source generation changed before lease settlement");
        }
        const completedAt = new Date();
        await tx
          .update(schema.scheduledTaskRuns)
          .set({
            status: input.status,
            knowledgeSyncRunId: input.knowledgeSyncRunId ?? null,
            knowledgeSummary: summary,
            completedAt,
            error: input.error ?? null,
            updatedAt: completedAt,
          })
          .where(eq(schema.scheduledTaskRuns.id, input.scheduledTaskRunId));
        await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({
            leaseId: null,
            leaseUntil: null,
            executionCheckpoint: input.executionCheckpoint ?? null,
            bufferedWake: false,
            bufferedScheduledTaskRunId: null,
            reconnectRequired: summary.reconnectRequired,
            sourceSyncGeneration: expectedSettledGeneration,
            lastCompletedAt: completedAt,
            ...(input.status === "succeeded" ? { lastSuccessAt: completedAt } : {}),
            lastSummary: summary,
            updatedAt: completedAt,
          })
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId));
        await tx
          .update(schema.knowledgeSourceSyncWakes)
          .set({ completedAt })
          .where(eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId));
        const [nextWake] = await tx
          .select({ scheduledTaskRunId: schema.knowledgeSourceSyncWakes.scheduledTaskRunId })
          .from(schema.knowledgeSourceSyncWakes)
          .where(
            and(
              eq(schema.knowledgeSourceSyncWakes.sourceId, input.sourceId),
              sql`${schema.knowledgeSourceSyncWakes.completedAt} is null`,
            ),
          )
          .orderBy(sql`${schema.knowledgeSourceSyncWakes.createdAt} desc`)
          .limit(1);
        const supersededWakes = await tx
          .update(schema.knowledgeSourceSyncWakes)
          .set({ coalesced: true, claimedAt: completedAt, completedAt })
          .where(
            and(
              eq(schema.knowledgeSourceSyncWakes.sourceId, input.sourceId),
              sql`${schema.knowledgeSourceSyncWakes.completedAt} is null`,
              ...(nextWake
                ? [
                    sql`${schema.knowledgeSourceSyncWakes.scheduledTaskRunId} <> ${nextWake.scheduledTaskRunId}::uuid`,
                  ]
                : []),
            ),
          )
          .returning({ scheduledTaskRunId: schema.knowledgeSourceSyncWakes.scheduledTaskRunId });
        if (supersededWakes.length > 0) {
          await tx
            .update(schema.scheduledTaskRuns)
            .set({ status: "skipped", completedAt, updatedAt: completedAt })
            .where(
              sql`${schema.scheduledTaskRuns.id} in (${sql.join(
                supersededWakes.map((wake) => sql`${wake.scheduledTaskRunId}::uuid`),
                sql`, `,
              )})`,
            );
        }
        await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({
            pendingWakeCount: nextWake ? 1 : 0,
          })
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId));
        return {
          bufferedWake: Boolean(nextWake),
          bufferedScheduledTaskRunId: nextWake?.scheduledTaskRunId ?? null,
        };
      }),
  );
}

/**
 * Release only the exact active lease after a retryable DB safety obligation
 * fails. The wake and scheduled-task run deliberately remain open so Temporal
 * can reclaim the same deterministic run; no provider checkpoint survives a
 * reconnect/permission-loss failure.
 */
export async function releaseKnowledgeSourceSyncLeaseForRetry(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [released] = await scopedDb
        .update(schema.knowledgeSourceSyncStates)
        .set({
          leaseId: null,
          leaseUntil: null,
          executionCheckpoint: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId),
            eq(schema.knowledgeSourceSyncStates.leaseId, input.scheduledTaskRunId),
          ),
        )
        .returning({ sourceId: schema.knowledgeSourceSyncStates.sourceId });
      if (!released) {
        throw new Error("Knowledge source sync lease changed before retry release");
      }
    },
  );
}

export async function completeKnowledgeSourceSyncWakeWithoutLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.transaction(async (tx) => {
        const completedAt = new Date();
        const [wake] = await tx
          .update(schema.knowledgeSourceSyncWakes)
          .set({ claimedAt: completedAt, completedAt })
          .where(
            and(
              eq(schema.knowledgeSourceSyncWakes.scheduledTaskRunId, input.scheduledTaskRunId),
              sql`${schema.knowledgeSourceSyncWakes.completedAt} is null`,
            ),
          )
          .returning({ id: schema.knowledgeSourceSyncWakes.id });
        if (!wake) return;
        await tx
          .update(schema.knowledgeSourceSyncStates)
          .set({
            pendingWakeCount: sql`greatest(${schema.knowledgeSourceSyncStates.pendingWakeCount} - 1, 0)`,
            updatedAt: completedAt,
          })
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId));
      });
    },
  );
}

export async function recordKnowledgeSourceSyncItemOutcomes(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    scheduledTaskRunId: string;
    knowledgeSyncRunId?: string | null;
    sourceId: string;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    outcomes: Array<{
      externalObjectId: string;
      outcome: "imported" | "unchanged" | "skipped" | "failed" | "tombstoned";
      reasonCode?: string | null;
      detail?: string | null;
      contentSha256?: string | null;
      sizeBytes?: number | null;
      providerRevision?: string | null;
      metadataHash?: string | null;
      aclEligibility?: "pending" | "eligible" | "denied";
      aclEvidence?: Record<string, unknown> | null;
      indexObligationId?: string | null;
    }>;
  },
): Promise<void> {
  if (input.outcomes.length === 0) return;
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .insert(schema.knowledgeSourceSyncItemOutcomes)
        .values(
          input.outcomes.map((outcome) => ({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            scheduledTaskRunId: input.scheduledTaskRunId,
            knowledgeSyncRunId: input.knowledgeSyncRunId ?? null,
            sourceId: input.sourceId,
            sourceConfigGeneration: input.sourceConfigGeneration,
            sourceLifecycleGeneration: input.sourceLifecycleGeneration,
            externalObjectId: outcome.externalObjectId,
            providerRevision: outcome.providerRevision ?? null,
            metadataHash: outcome.metadataHash ?? null,
            aclEligibility: outcome.aclEligibility ?? "pending",
            aclEvidence: outcome.aclEvidence ?? null,
            indexObligationId: outcome.indexObligationId ?? null,
            outcome: outcome.outcome,
            reasonCode: outcome.reasonCode ?? null,
            detail: outcome.detail?.slice(0, 1000) ?? null,
            contentSha256: outcome.contentSha256 ?? null,
            sizeBytes: outcome.sizeBytes ?? null,
          })),
        )
        .onConflictDoNothing();
    },
  );
}

export async function recordKnowledgeSourceSyncObjectObservations(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    scanGeneration: number;
    observations: Array<{
      externalObjectId: string;
      providerRevision?: string | null;
      metadataHash?: string | null;
    }>;
  },
): Promise<void> {
  if (input.observations.length === 0) return;
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      for (const observation of input.observations) {
        await scopedDb.execute(sql`
          INSERT INTO knowledge_source_sync_object_observations (
            source_id, external_object_id, account_id, workspace_id,
            scheduled_task_run_id, scan_generation, provider_revision,
            metadata_hash, observed_at
          ) VALUES (
            ${input.sourceId}::uuid, ${observation.externalObjectId},
            ${input.accountId}::uuid, ${input.workspaceId}::uuid,
            ${input.scheduledTaskRunId}::uuid, ${input.scanGeneration}::bigint,
            ${observation.providerRevision ?? null}, ${observation.metadataHash ?? null},
            clock_timestamp()
          )
          ON CONFLICT (source_id, external_object_id) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            workspace_id = EXCLUDED.workspace_id,
            scheduled_task_run_id = EXCLUDED.scheduled_task_run_id,
            scan_generation = EXCLUDED.scan_generation,
            provider_revision = EXCLUDED.provider_revision,
            metadata_hash = EXCLUDED.metadata_hash,
            observed_at = EXCLUDED.observed_at
          WHERE knowledge_source_sync_object_observations.scan_generation <= EXCLUDED.scan_generation
        `);
      }
    },
  );
}

export async function reconcileKnowledgeSourceSyncCompleteScan(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    scheduledTaskRunId: string;
    initiatingSubjectId: string;
    sourceSyncGeneration: number;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    scanGeneration: number;
  },
): Promise<string[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await setSubjectRlsContext(tx, input.initiatingSubjectId);
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, input.sourceId))
          .for("update")
          .limit(1);
        if (
          !state ||
          state.leaseId !== input.scheduledTaskRunId ||
          state.initiatingSubjectId !== input.initiatingSubjectId ||
          state.sourceSyncGeneration !== input.sourceSyncGeneration ||
          state.sourceConfigGeneration !== input.sourceConfigGeneration ||
          state.sourceLifecycleGeneration !== input.sourceLifecycleGeneration ||
          state.activeScanGeneration !== input.scanGeneration
        ) {
          throw new Error("Knowledge source complete-scan authority changed");
        }
        const missing = await tx
          .select({
            id: schema.knowledgeSourceObjects.id,
            externalObjectId: schema.knowledgeSourceObjects.externalObjectId,
            lifecycleGeneration: schema.knowledgeSourceObjects.lifecycleGeneration,
          })
          .from(schema.knowledgeSourceObjects)
          .leftJoin(
            schema.knowledgeSourceSyncObjectObservations,
            and(
              eq(
                schema.knowledgeSourceSyncObjectObservations.sourceId,
                schema.knowledgeSourceObjects.sourceId,
              ),
              eq(
                schema.knowledgeSourceSyncObjectObservations.externalObjectId,
                schema.knowledgeSourceObjects.externalObjectId,
              ),
            ),
          )
          .where(
            and(
              eq(schema.knowledgeSourceObjects.sourceId, input.sourceId),
              eq(schema.knowledgeSourceObjects.lifecycleState, "active"),
              sql`coalesce(${schema.knowledgeSourceSyncObjectObservations.scanGeneration}, 0) < ${input.scanGeneration}`,
            ),
          )
          .orderBy(schema.knowledgeSourceObjects.id);
        if (missing[0]) {
          await tx.execute(sql`
            SELECT knowledge_source_sync_lock_authority(
              ${input.accountId}::uuid,
              ${input.sourceId}::uuid,
              ${missing[0].id}::uuid
            )
          `);
          for (const object of missing.slice(1)) {
            await tx.execute(sql`
              SELECT knowledge_source_sync_lock_authority(
                ${input.accountId}::uuid,
                ${input.sourceId}::uuid,
                ${object.id}::uuid
              )
            `);
          }
        } else {
          await tx.execute(sql`
            SELECT knowledge_source_sync_lock_authority(
              ${input.accountId}::uuid,
              ${input.sourceId}::uuid,
              NULL::uuid
            )
          `);
        }
        const [source] = await tx
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, input.sourceId))
          .limit(1);
        if (
          !source ||
          source.lifecycleState !== "active" ||
          source.lifecycleGeneration !== input.sourceLifecycleGeneration ||
          source.syncGeneration !== input.sourceSyncGeneration
        ) {
          throw new Error("Knowledge source changed before complete-scan reconciliation");
        }
        for (const object of missing) {
          await recordKnowledgeLifecycleEvent(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            targetKind: "object",
            targetId: object.id,
            eventType: "deleted",
            expectedGeneration: object.lifecycleGeneration,
            operationId: `knowledge-sync-missing:${input.sourceId}:${input.scanGeneration}:${object.id}`,
            reasonCode: "authoritative_scan_absent",
            actor: {
              kind: "service",
              subjectId: "knowledge-source-sync",
              initiatingHumanSubjectId: input.initiatingSubjectId,
            },
          });
        }
        return missing.map((object) => object.externalObjectId);
      }),
  );
}

export async function getKnowledgeSourceSyncIndexObligationForVersion(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    knowledgeDocumentVersionId: string;
    initiatingSubjectId: string;
  },
): Promise<{
  id: string;
  status: string;
  aclEligibility: string;
  sourceSyncGeneration: number;
  documentId: string;
} | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.initiatingSubjectId);
      const [row] = await scopedDb
        .select()
        .from(schema.knowledgeSourceSyncIndexObligations)
        .where(
          eq(
            schema.knowledgeSourceSyncIndexObligations.knowledgeDocumentVersionId,
            input.knowledgeDocumentVersionId,
          ),
        )
        .limit(1);
      return row
        ? {
            id: row.id,
            status: row.status,
            aclEligibility: row.aclEligibility,
            sourceSyncGeneration: row.sourceSyncGeneration,
            documentId: row.documentId,
          }
        : null;
    },
  );
}

export async function enqueueKnowledgeSourceSyncIndexObligation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    scheduledTaskRunId: string;
    sourceId: string;
    sourceSyncGeneration: number;
    initiatingSubjectId: string;
    externalObjectId: string;
    knowledgeSourceObjectId: string;
    knowledgeDocumentVersionId: string;
    documentId: string;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    objectLifecycleGeneration: number;
    objectVersionGeneration: number;
    citationLocator: Record<string, unknown>;
  },
): Promise<{
  id: string;
  status: string;
  aclEligibility: string;
  sourceSyncGeneration: number;
  documentId: string;
}> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [inserted] = await scopedDb
        .insert(schema.knowledgeSourceSyncIndexObligations)
        .values({ ...input, aclEligibility: "pending", status: "pending" })
        .onConflictDoNothing({
          target: schema.knowledgeSourceSyncIndexObligations.knowledgeDocumentVersionId,
        })
        .returning();
      const [row] = inserted
        ? [inserted]
        : await scopedDb
            .select()
            .from(schema.knowledgeSourceSyncIndexObligations)
            .where(
              eq(
                schema.knowledgeSourceSyncIndexObligations.knowledgeDocumentVersionId,
                input.knowledgeDocumentVersionId,
              ),
            )
            .limit(1);
      if (!row || row.documentId !== input.documentId || row.sourceId !== input.sourceId) {
        throw new Error("Knowledge source index obligation identity conflicted");
      }
      if (
        row.knowledgeSourceObjectId !== input.knowledgeSourceObjectId ||
        row.sourceSyncGeneration !== input.sourceSyncGeneration ||
        row.initiatingSubjectId !== input.initiatingSubjectId ||
        row.externalObjectId !== input.externalObjectId ||
        row.sourceConfigGeneration !== input.sourceConfigGeneration ||
        row.sourceLifecycleGeneration !== input.sourceLifecycleGeneration ||
        row.objectLifecycleGeneration !== input.objectLifecycleGeneration ||
        row.objectVersionGeneration !== input.objectVersionGeneration
      ) {
        throw new Error("Knowledge source index obligation authority conflicted");
      }
      return {
        id: row.id,
        status: row.status,
        aclEligibility: row.aclEligibility,
        sourceSyncGeneration: row.sourceSyncGeneration,
        documentId: row.documentId,
      };
    },
  );
}

/**
 * Re-open a transiently failed index obligation only while its complete
 * source/object/version authority is still current. The immutable obligation
 * identity and original source-sync generation remain intact; the new task run
 * merely becomes the retry owner.
 */
export async function retryKnowledgeSourceSyncIndexObligation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    obligationId: string;
    scheduledTaskRunId: string;
  },
): Promise<"pending" | "indexed" | "invalidated"> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [observed] = await tx
          .select()
          .from(schema.knowledgeSourceSyncIndexObligations)
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
          .limit(1);
        if (!observed) throw new Error("Knowledge source index obligation was not found");
        await setSubjectRlsContext(tx, observed.initiatingSubjectId);
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, observed.sourceId))
          .for("update")
          .limit(1);
        if (state) {
          await tx.execute(sql`
            SELECT knowledge_source_sync_lock_authority(
              ${input.accountId}::uuid,
              ${observed.sourceId}::uuid,
              ${observed.knowledgeSourceObjectId}::uuid
            )
          `);
        }
        const [[obligation], [source], [object], [version]] = await Promise.all([
          tx
            .select()
            .from(schema.knowledgeSourceSyncIndexObligations)
            .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
            .for("update")
            .limit(1),
          state
            ? tx
                .select()
                .from(schema.knowledgeSources)
                .where(eq(schema.knowledgeSources.id, observed.sourceId))
                .limit(1)
            : Promise.resolve([]),
          state
            ? tx
                .select()
                .from(schema.knowledgeSourceObjects)
                .where(eq(schema.knowledgeSourceObjects.id, observed.knowledgeSourceObjectId))
                .limit(1)
            : Promise.resolve([]),
          state
            ? tx
                .select()
                .from(schema.knowledgeDocumentVersions)
                .where(eq(schema.knowledgeDocumentVersions.id, observed.knowledgeDocumentVersionId))
                .limit(1)
            : Promise.resolve([]),
        ]);
        if (!obligation) throw new Error("Knowledge source index obligation was not found");
        if (obligation.status === "indexed") return "indexed";
        if (obligation.status === "invalidated") return "invalidated";
        const current =
          state &&
          source &&
          object &&
          version &&
          state.leaseId === input.scheduledTaskRunId &&
          state.sourceSyncGeneration >= obligation.sourceSyncGeneration &&
          state.initiatingSubjectId === obligation.initiatingSubjectId &&
          state.sourceConfigGeneration === obligation.sourceConfigGeneration &&
          state.sourceLifecycleGeneration === obligation.sourceLifecycleGeneration &&
          source.lifecycleState === "active" &&
          source.syncGeneration >= obligation.sourceSyncGeneration &&
          source.lifecycleGeneration === obligation.sourceLifecycleGeneration &&
          source.currentAclGeneration === version.aclGeneration &&
          object.sourceId === obligation.sourceId &&
          object.externalObjectId === obligation.externalObjectId &&
          object.lifecycleState === "active" &&
          object.lifecycleGeneration === obligation.objectLifecycleGeneration &&
          object.versionGeneration === obligation.objectVersionGeneration &&
          object.currentVersionId === obligation.knowledgeDocumentVersionId &&
          version.objectId === obligation.knowledgeSourceObjectId &&
          version.documentId === obligation.documentId;
        if (!current) {
          const invalidatedAt = new Date();
          await tx
            .update(schema.knowledgeSourceSyncIndexObligations)
            .set({
              status: "invalidated",
              aclEligibility: "denied",
              failureCode: "stale_index_retry",
              updatedAt: invalidatedAt,
            })
            .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId));
          await tx
            .update(schema.documents)
            .set({ agentAccess: false, chunkCount: 0, updatedAt: invalidatedAt })
            .where(eq(schema.documents.id, obligation.documentId));
          await tx
            .delete(schema.documentChunks)
            .where(eq(schema.documentChunks.documentId, obligation.documentId));
          return "invalidated";
        }
        if (obligation.status === "failed") {
          await tx
            .update(schema.knowledgeSourceSyncIndexObligations)
            .set({
              scheduledTaskRunId: input.scheduledTaskRunId,
              status: "pending",
              failureCode: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId));
        }
        return "pending";
      }),
  );
}

export async function recordKnowledgeSourceSyncAclEvidence(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    obligationId: string;
    sourceSyncGeneration: number;
    sourceConfigGeneration: number;
    sourceLifecycleGeneration: number;
    objectLifecycleGeneration: number;
    objectVersionGeneration: number;
    eligibility: "eligible" | "denied";
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.transaction(async (tx) => {
        const [observedObligation] = await tx
          .select()
          .from(schema.knowledgeSourceSyncIndexObligations)
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
          .limit(1);
        if (!observedObligation) {
          throw new Error("Knowledge source ACL evidence obligation was not found");
        }
        await setSubjectRlsContext(tx, observedObligation.initiatingSubjectId);
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, observedObligation.sourceId))
          .for("update")
          .limit(1);
        if (!state) throw new Error("Knowledge source sync authorization is no longer active");
        await tx.execute(sql`
          SELECT knowledge_source_sync_lock_authority(
            ${input.accountId}::uuid,
            ${observedObligation.sourceId}::uuid,
            ${observedObligation.knowledgeSourceObjectId}::uuid
          )
        `);
        const [source] = await tx
          .select()
          .from(schema.knowledgeSources)
          .where(eq(schema.knowledgeSources.id, observedObligation.sourceId))
          .limit(1);
        const [object] = await tx
          .select()
          .from(schema.knowledgeSourceObjects)
          .where(eq(schema.knowledgeSourceObjects.id, observedObligation.knowledgeSourceObjectId))
          .limit(1);
        const [version] = await tx
          .select()
          .from(schema.knowledgeDocumentVersions)
          .where(
            eq(schema.knowledgeDocumentVersions.id, observedObligation.knowledgeDocumentVersionId),
          )
          .limit(1);
        const [obligation] = await tx
          .select()
          .from(schema.knowledgeSourceSyncIndexObligations)
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
          .for("update")
          .limit(1);
        const [document] = obligation
          ? await tx
              .select()
              .from(schema.documents)
              .where(eq(schema.documents.id, obligation.documentId))
              .for("update")
              .limit(1)
          : [];
        if (
          !obligation ||
          !source ||
          !object ||
          !version ||
          !document ||
          input.sourceSyncGeneration !== obligation.sourceSyncGeneration ||
          state.sourceSyncGeneration < input.sourceSyncGeneration ||
          state.initiatingSubjectId !== obligation.initiatingSubjectId ||
          state.sourceSyncGeneration < obligation.sourceSyncGeneration ||
          state.sourceConfigGeneration !== input.sourceConfigGeneration ||
          state.sourceConfigGeneration !== obligation.sourceConfigGeneration ||
          state.sourceLifecycleGeneration !== input.sourceLifecycleGeneration ||
          state.sourceLifecycleGeneration !== obligation.sourceLifecycleGeneration ||
          source.lifecycleState !== "active" ||
          source.syncGeneration < obligation.sourceSyncGeneration ||
          source.lifecycleGeneration !== obligation.sourceLifecycleGeneration ||
          source.currentAclGeneration !== version.aclGeneration ||
          object.sourceId !== obligation.sourceId ||
          object.externalObjectId !== obligation.externalObjectId ||
          object.lifecycleState !== "active" ||
          object.lifecycleGeneration !== obligation.objectLifecycleGeneration ||
          object.versionGeneration !== obligation.objectVersionGeneration ||
          object.currentVersionId !== obligation.knowledgeDocumentVersionId ||
          version.sourceId !== obligation.sourceId ||
          version.objectId !== obligation.knowledgeSourceObjectId ||
          version.versionGeneration !== obligation.objectVersionGeneration ||
          version.documentId !== obligation.documentId ||
          version.fileId !== document.fileId ||
          document.accountId !== input.accountId ||
          document.workspaceId !== input.workspaceId ||
          document.sourceExternalId !== obligation.externalObjectId ||
          !document.knowledgeSourceIdentity ||
          obligation.sourceConfigGeneration !== input.sourceConfigGeneration ||
          obligation.sourceSyncGeneration !== input.sourceSyncGeneration ||
          obligation.sourceLifecycleGeneration !== input.sourceLifecycleGeneration ||
          obligation.objectLifecycleGeneration !== input.objectLifecycleGeneration ||
          obligation.objectVersionGeneration !== input.objectVersionGeneration
        ) {
          throw new Error("Knowledge source ACL evidence authority changed");
        }
        if (input.eligibility === "eligible" && obligation.status !== "indexed") {
          throw new Error("Knowledge source ACL eligibility requires a completed index obligation");
        }
        await tx
          .update(schema.knowledgeSourceSyncIndexObligations)
          .set({ aclEligibility: input.eligibility, updatedAt: new Date() })
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId));
        await tx
          .update(schema.knowledgeSourceSyncItemOutcomes)
          .set({ aclEligibility: input.eligibility, aclEvidence: input.evidence })
          .where(eq(schema.knowledgeSourceSyncItemOutcomes.indexObligationId, input.obligationId));
        const [updatedDocument] = await tx
          .update(schema.documents)
          .set({ agentAccess: input.eligibility === "eligible", updatedAt: new Date() })
          .where(eq(schema.documents.id, obligation.documentId))
          .returning({ id: schema.documents.id });
        if (!updatedDocument) {
          throw new Error("Knowledge source ACL evidence document authority changed");
        }
      });
    },
  );
}

/** Bounded retention hook. Callers choose policy and cadence; pending index or
 * ACL obligations are never deleted by age alone. */
export async function pruneKnowledgeSourceSyncEvidence(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    before: Date;
    limit?: number;
  },
): Promise<{ itemOutcomes: number; wakes: number; indexObligations: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? 500, 5_000));
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [counts] = await scopedDb.execute<{
        item_outcomes: number;
        wakes: number;
        index_obligations: number;
      }>(sql`
        WITH deleted_items AS (
          DELETE FROM knowledge_source_sync_item_outcomes
          WHERE id IN (
            SELECT id FROM knowledge_source_sync_item_outcomes
            WHERE workspace_id = ${input.workspaceId}::uuid AND created_at < ${input.before}
            ORDER BY created_at ASC LIMIT ${limit}
          ) RETURNING 1
        ), deleted_wakes AS (
          DELETE FROM knowledge_source_sync_wakes
          WHERE id IN (
            SELECT id FROM knowledge_source_sync_wakes
            WHERE workspace_id = ${input.workspaceId}::uuid
              AND completed_at IS NOT NULL AND completed_at < ${input.before}
            ORDER BY completed_at ASC LIMIT ${limit}
          ) RETURNING 1
        ), deleted_obligations AS (
          DELETE FROM knowledge_source_sync_index_obligations
          WHERE id IN (
            SELECT id FROM knowledge_source_sync_index_obligations
            WHERE workspace_id = ${input.workspaceId}::uuid
              AND status IN ('indexed', 'failed', 'invalidated')
              AND acl_eligibility <> 'pending'
              AND updated_at < ${input.before}
            ORDER BY updated_at ASC LIMIT ${limit}
          ) RETURNING 1
        )
        SELECT
          (SELECT count(*)::int FROM deleted_items) AS item_outcomes,
          (SELECT count(*)::int FROM deleted_wakes) AS wakes,
          (SELECT count(*)::int FROM deleted_obligations) AS index_obligations
      `);
      return {
        itemOutcomes: counts?.item_outcomes ?? 0,
        wakes: counts?.wakes ?? 0,
        indexObligations: counts?.index_obligations ?? 0,
      };
    },
  );
}

export async function settleKnowledgeSourceSyncIndexObligation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    obligationId: string;
    status: "indexed" | "failed" | "invalidated";
    failureCode?: string | null;
  },
): Promise<"settled" | "invalidated"> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const settlement = await scopedDb.transaction(async (tx) => {
        const [observedObligation] = await tx
          .select()
          .from(schema.knowledgeSourceSyncIndexObligations)
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
          .limit(1);
        if (!observedObligation) {
          throw new Error("Knowledge source index obligation is no longer pending");
        }
        await setSubjectRlsContext(tx, observedObligation.initiatingSubjectId);
        const [state] = await tx
          .select()
          .from(schema.knowledgeSourceSyncStates)
          .where(eq(schema.knowledgeSourceSyncStates.sourceId, observedObligation.sourceId))
          .for("update")
          .limit(1);
        if (state) {
          await tx.execute(sql`
            SELECT knowledge_source_sync_lock_authority(
              ${input.accountId}::uuid,
              ${observedObligation.sourceId}::uuid,
              ${observedObligation.knowledgeSourceObjectId}::uuid
            )
          `);
        }
        const [obligation] = await tx
          .select()
          .from(schema.knowledgeSourceSyncIndexObligations)
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId))
          .for("update")
          .limit(1);
        if (!obligation) {
          throw new Error("Knowledge source index obligation is no longer pending");
        }
        if (
          obligation.sourceId !== observedObligation.sourceId ||
          obligation.knowledgeSourceObjectId !== observedObligation.knowledgeSourceObjectId ||
          obligation.knowledgeDocumentVersionId !== observedObligation.knowledgeDocumentVersionId ||
          obligation.documentId !== observedObligation.documentId ||
          obligation.initiatingSubjectId !== observedObligation.initiatingSubjectId
        ) {
          throw new Error("Knowledge source index obligation authority changed");
        }
        const cleanInvalidatedDocument = async () => {
          const invalidatedAt = new Date();
          await tx
            .update(schema.documents)
            .set({ agentAccess: false, chunkCount: 0, updatedAt: invalidatedAt })
            .where(eq(schema.documents.id, obligation.documentId));
          await tx
            .delete(schema.documentChunks)
            .where(eq(schema.documentChunks.documentId, obligation.documentId));
        };
        if (obligation.status !== "pending") {
          if (input.status === "indexed" && obligation.status === "invalidated") {
            await cleanInvalidatedDocument();
            return "invalidated" as const;
          }
          throw new Error("Knowledge source index obligation is no longer pending");
        }
        if (input.status === "indexed") {
          const [source] = state
            ? await tx
                .select()
                .from(schema.knowledgeSources)
                .where(eq(schema.knowledgeSources.id, obligation.sourceId))
                .limit(1)
            : [];
          const [object] = state
            ? await tx
                .select()
                .from(schema.knowledgeSourceObjects)
                .where(eq(schema.knowledgeSourceObjects.id, obligation.knowledgeSourceObjectId))
                .limit(1)
            : [];
          const [version] = state
            ? await tx
                .select()
                .from(schema.knowledgeDocumentVersions)
                .where(
                  eq(schema.knowledgeDocumentVersions.id, obligation.knowledgeDocumentVersionId),
                )
                .limit(1)
            : [];
          const current =
            state &&
            source &&
            object &&
            version &&
            state.sourceSyncGeneration >= obligation.sourceSyncGeneration &&
            state.initiatingSubjectId === obligation.initiatingSubjectId &&
            state.sourceConfigGeneration === obligation.sourceConfigGeneration &&
            state.sourceLifecycleGeneration === obligation.sourceLifecycleGeneration &&
            source.lifecycleState === "active" &&
            source.syncGeneration >= obligation.sourceSyncGeneration &&
            source.lifecycleGeneration === obligation.sourceLifecycleGeneration &&
            source.currentAclGeneration === version.aclGeneration &&
            object.sourceId === obligation.sourceId &&
            object.externalObjectId === obligation.externalObjectId &&
            object.lifecycleState === "active" &&
            object.lifecycleGeneration === obligation.objectLifecycleGeneration &&
            object.versionGeneration === obligation.objectVersionGeneration &&
            object.currentVersionId === obligation.knowledgeDocumentVersionId &&
            version.objectId === obligation.knowledgeSourceObjectId &&
            version.documentId === obligation.documentId;
          if (!current) {
            const invalidatedAt = new Date();
            await tx
              .update(schema.knowledgeSourceSyncIndexObligations)
              .set({
                status: "invalidated",
                aclEligibility: "denied",
                failureCode: "stale_index_completion",
                updatedAt: invalidatedAt,
              })
              .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId));
            await cleanInvalidatedDocument();
            return "invalidated" as const;
          }
        }
        await tx
          .update(schema.knowledgeSourceSyncIndexObligations)
          .set({
            status: input.status,
            failureCode: input.failureCode ?? null,
            updatedAt: new Date(),
          })
          .where(eq(schema.knowledgeSourceSyncIndexObligations.id, input.obligationId));
        return "settled" as const;
      });
      return settlement;
    },
  );
}

export async function ensureKnowledgeSourceBlobFile(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    fileId: string;
    filename: string;
    safeFilename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    bucket: string;
    objectKey: string;
  },
): Promise<FileAsset> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [inserted] = await scopedDb
        .insert(schema.files)
        .values({
          id: input.fileId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          status: "ready",
          filename: input.filename,
          safeFilename: input.safeFilename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          bucket: input.bucket,
          objectKey: input.objectKey,
        })
        .onConflictDoNothing({ target: schema.files.objectKey })
        .returning();
      const [row] = inserted
        ? [inserted]
        : await scopedDb
            .select()
            .from(schema.files)
            .where(eq(schema.files.objectKey, input.objectKey))
            .limit(1);
      if (
        !row ||
        row.accountId !== input.accountId ||
        row.workspaceId !== input.workspaceId ||
        row.status !== "ready" ||
        row.sha256 !== input.sha256 ||
        row.sizeBytes !== input.sizeBytes ||
        row.contentType !== input.contentType
      ) {
        throw new Error("Canonical knowledge blob identity conflicted");
      }
      return {
        id: row.id,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        status: row.status as FileAsset["status"],
        filename: row.filename,
        safeFilename: row.safeFilename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        bucket: row.bucket,
        objectKey: row.objectKey,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );
}

function mapState(
  row: typeof schema.knowledgeSourceSyncStates.$inferSelect,
): KnowledgeSourceSyncState {
  return {
    sourceId: row.sourceId,
    scheduledTaskId: row.scheduledTaskId,
    sourceSyncGeneration: row.sourceSyncGeneration,
    sourceConfigGeneration: row.sourceConfigGeneration,
    sourceLifecycleGeneration: row.sourceLifecycleGeneration,
    executionCheckpoint: row.executionCheckpoint,
    executionCheckpointGeneration: row.executionCheckpointGeneration,
    activeScanGeneration: row.activeScanGeneration,
    providerCursor: row.providerCursor,
    wakeRevision: row.wakeRevision,
    pendingWakeCount: row.pendingWakeCount,
    bufferedWake: row.bufferedWake,
    bufferedScheduledTaskRunId: row.bufferedScheduledTaskRunId,
    reconnectRequired: row.reconnectRequired,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
    lastSummary: row.lastSummary ? KnowledgeSourceSyncRunSummary.parse(row.lastSummary) : null,
  };
}
