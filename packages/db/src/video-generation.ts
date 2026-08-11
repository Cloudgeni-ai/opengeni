import {
  GENERATED_VIDEO_MAX_BYTES,
  GeneratedVideoReceipt,
  SEEDANCE_2_5_MODEL_ID,
  VideoGenerationPolicy,
  VideoGenerationOperationSummary,
  retainedGeneratedVideoReferenceFromFile,
  type GeneratedVideoFacts,
  type MediaGenerationResult,
  type VideoGenerationFundingSource,
  type VideoGenerationPolicy as VideoGenerationPolicyValue,
} from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext, withWorkspaceRls } from "./database";
import * as schema from "./schema";

export const ACTIVE_VIDEO_GENERATION_STATUSES = [
  "preparing",
  "prepared",
  "accepted",
  "submission_uncertain",
  "provider_started",
  "retaining",
] as const;

export type VideoGenerationOperation = typeof schema.videoGenerationOperations.$inferSelect;
export type VideoGenerationReference = typeof schema.videoGenerationReferences.$inferSelect;
export type GeneratedVideoArtifact = typeof schema.generatedVideoArtifacts.$inferSelect;

export type VideoGenerationOperationWithReferences = VideoGenerationOperation & {
  references: VideoGenerationReference[];
};

export class VideoGenerationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenerationConflictError";
  }
}

export class VideoGenerationCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenerationCapacityError";
  }
}

export class VideoGenerationCreditError extends Error {
  constructor(message = "insufficient OpenGeni credits") {
    super(message);
    this.name = "VideoGenerationCreditError";
  }
}

export async function getWorkspaceVideoGenerationPolicy(
  db: Database,
  workspaceId: string,
): Promise<VideoGenerationPolicyValue> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceVideoGenerationPolicies)
      .where(eq(schema.workspaceVideoGenerationPolicies.workspaceId, workspaceId))
      .limit(1);
    return policyFromRow(row);
  });
}

export async function updateWorkspaceVideoGenerationPolicy(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    expectedRevision: number;
    fundingSource: VideoGenerationFundingSource;
    enabledModelIds: string[];
    defaultModelId: string | null;
  },
): Promise<VideoGenerationPolicyValue> {
  const requested = VideoGenerationPolicy.parse({
    schemaVersion: 1,
    revision: input.expectedRevision + 1,
    fundingSource: input.fundingSource,
    enabledModelIds: input.enabledModelIds,
    defaultModelId: input.defaultModelId,
  });
  assertSupportedModels(requested.enabledModelIds);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [workspace] = await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, input.workspaceId),
              eq(schema.workspaces.accountId, input.accountId),
            ),
          )
          .for("update")
          .limit(1);
        if (!workspace) throw new Error("Workspace not found");
        const [current] = await tx
          .select()
          .from(schema.workspaceVideoGenerationPolicies)
          .where(eq(schema.workspaceVideoGenerationPolicies.workspaceId, input.workspaceId))
          .for("update")
          .limit(1);
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== input.expectedRevision) {
          throw new VideoGenerationConflictError("Video generation policy changed");
        }
        const now = new Date();
        const values = {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          revision: currentRevision + 1,
          fundingSource: requested.fundingSource,
          enabledModelIds: [...requested.enabledModelIds],
          defaultModelId: requested.defaultModelId,
          updatedBySubjectId: input.subjectId.slice(0, 1_024),
          updatedAt: now,
        };
        const [row] = current
          ? await tx
              .update(schema.workspaceVideoGenerationPolicies)
              .set(values)
              .where(eq(schema.workspaceVideoGenerationPolicies.workspaceId, input.workspaceId))
              .returning()
          : await tx.insert(schema.workspaceVideoGenerationPolicies).values(values).returning();
        if (!row) throw new Error("Video generation policy update was not persisted");
        return policyFromRow(row);
      }),
  );
}

export type AdmitVideoGenerationOperationInput = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  admissionKey: string;
  requestDigest: string;
  promptDigest: string;
  requestEncrypted: string;
  modelId: string;
  sourceMode: string;
  capabilityRevision: string;
  policyRevision: number;
  fundingSource: VideoGenerationFundingSource;
  pricedCostMicros: number;
  connectionId: string | null;
  credentialVersion: number;
  credentialEncrypted: string;
  providerIdempotencyKey: string;
  expectedArtifactId: string;
  expectedFileId: string;
  reservedBytes?: number;
  workspaceQuotaBytes: number;
  maxConcurrentPerWorkspace: number;
  recoveryDeadlineAt: Date;
  references: Array<{
    ordinal: number;
    role: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    stagingObjectKey: string;
    grantExpiresAt?: Date | null;
    cleanupAfter: Date;
  }>;
};

export async function admitVideoGenerationOperation(
  db: Database,
  input: AdmitVideoGenerationOperationInput,
): Promise<{ operation: VideoGenerationOperation; created: boolean }> {
  const reservedBytes = input.reservedBytes ?? GENERATED_VIDEO_MAX_BYTES;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`video-generation:${input.admissionKey}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(schema.videoGenerationOperations)
          .where(
            and(
              eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
              eq(schema.videoGenerationOperations.admissionKey, input.admissionKey),
            ),
          )
          .limit(1);
        if (existing) {
          assertAdmissionMatches(existing, input);
          return { operation: existing, created: false };
        }
        const [policy] = await tx
          .select()
          .from(schema.workspaceVideoGenerationPolicies)
          .where(eq(schema.workspaceVideoGenerationPolicies.workspaceId, input.workspaceId))
          .for("update")
          .limit(1);
        if (
          !policy ||
          policy.revision !== input.policyRevision ||
          policy.fundingSource !== input.fundingSource ||
          !policy.enabledModelIds.includes(input.modelId)
        ) {
          throw new VideoGenerationConflictError("Video generation capability changed");
        }
        const active = await tx
          .select({ id: schema.videoGenerationOperations.id })
          .from(schema.videoGenerationOperations)
          .where(
            and(
              eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
              inArray(schema.videoGenerationOperations.status, [
                ...ACTIVE_VIDEO_GENERATION_STATUSES,
              ]),
            ),
          )
          .for("update");
        if (active.length >= input.maxConcurrentPerWorkspace) {
          throw new VideoGenerationCapacityError("Workspace video generation limit reached");
        }
        await tx
          .insert(schema.workspaceVideoGenerationQuotas)
          .values({ workspaceId: input.workspaceId, accountId: input.accountId })
          .onConflictDoNothing({ target: schema.workspaceVideoGenerationQuotas.workspaceId });
        const [quota] = await tx
          .select()
          .from(schema.workspaceVideoGenerationQuotas)
          .where(eq(schema.workspaceVideoGenerationQuotas.workspaceId, input.workspaceId))
          .for("update")
          .limit(1);
        if (!quota) throw new Error("Video generation quota row disappeared");
        if (quota.reservedBytes + quota.readyBytes + reservedBytes > input.workspaceQuotaBytes) {
          throw new VideoGenerationCapacityError("Workspace video storage quota reached");
        }
        const [operation] = await tx
          .insert(schema.videoGenerationOperations)
          .values({
            id: input.id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            toolCallId: input.toolCallId,
            admissionKey: input.admissionKey,
            requestDigest: input.requestDigest,
            promptDigest: input.promptDigest,
            requestEncrypted: input.requestEncrypted,
            modelId: input.modelId,
            sourceMode: input.sourceMode,
            capabilityRevision: input.capabilityRevision,
            fundingSource: input.fundingSource,
            pricedCostMicros: input.pricedCostMicros,
            creditState: input.pricedCostMicros > 0 ? "debited" : "not_applicable",
            connectionId: input.connectionId,
            credentialVersion: input.credentialVersion,
            credentialEncrypted: input.credentialEncrypted,
            providerIdempotencyKey: input.providerIdempotencyKey,
            expectedArtifactId: input.expectedArtifactId,
            expectedFileId: input.expectedFileId,
            reservedBytes,
            recoveryDeadlineAt: input.recoveryDeadlineAt,
            status: input.references.length === 0 ? "prepared" : "preparing",
            admissionOutputState: "pending",
            terminalUpdateState: "ineligible",
          })
          .returning();
        if (!operation) throw new Error("Video generation operation was not admitted");
        if (input.pricedCostMicros > 0) {
          if (input.fundingSource !== "opengeni_credits" || input.connectionId !== null) {
            throw new Error("Only OpenGeni-funded video operations may debit credits");
          }
          await debitVideoGenerationCredits(tx, operation);
        }
        if (input.references.length > 0) {
          await tx.insert(schema.videoGenerationReferences).values(
            input.references.map((reference) => ({
              operationId: operation.id,
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              grantExpiresAt: reference.grantExpiresAt ?? null,
              ...reference,
            })),
          );
        }
        await tx
          .update(schema.workspaceVideoGenerationQuotas)
          .set({
            reservedBytes: sql`${schema.workspaceVideoGenerationQuotas.reservedBytes} + ${reservedBytes}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.workspaceVideoGenerationQuotas.workspaceId, input.workspaceId));
        return { operation, created: true };
      }),
  );
}

/**
 * Seal a reference-bearing operation only after every immutable staging object
 * has been uploaded and independently verified by the worker.  The source
 * sandbox path is intentionally not stored, so a failed preparation can only
 * be retried by the same logical tool call while its sandbox still exists.
 */
export async function markVideoGenerationPrepared(
  db: Database,
  input: OperationMutationInput,
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status === "prepared") return operation;
    if (operation.status !== "preparing") throw invalidTransition(operation, "prepared");
    const references = await tx
      .select({
        stagingObjectKey: schema.videoGenerationReferences.stagingObjectKey,
        cleanedAt: schema.videoGenerationReferences.cleanedAt,
      })
      .from(schema.videoGenerationReferences)
      .where(eq(schema.videoGenerationReferences.operationId, operation.id));
    if (
      references.length === 0 ||
      references.some((reference) => !reference.stagingObjectKey || reference.cleanedAt)
    ) {
      throw new VideoGenerationConflictError("Video references are not sealed");
    }
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({ status: "prepared", updatedAt: new Date() })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    return requireRow(updated, "seal video generation references");
  });
}

/** Final authorization fence. Call only after the accepted function output is durable. */
export async function markVideoGenerationAccepted(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    requestDigest: string;
  },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(
    db,
    input,
    async (tx, operation) =>
      await markVideoGenerationAcceptedInTransaction(tx, {
        workspaceId: input.workspaceId,
        operation,
      }),
  );
}

/**
 * Transactional half of acceptance.  The pending function result and this
 * transition must commit together: the provider reconciler never observes an
 * accepted operation whose model-visible `accepted` receipt was lost.
 */
export async function markVideoGenerationAcceptedInTransaction(
  tx: Database,
  input: {
    workspaceId: string;
    operation: VideoGenerationOperation;
    toolCallId?: string;
  },
): Promise<VideoGenerationOperation> {
  const operation = input.operation;
  if (input.toolCallId !== undefined && operation.toolCallId !== input.toolCallId) {
    throw new VideoGenerationConflictError("Video generation tool-call identity changed");
  }
  if (operation.admissionOutputState === "recorded") return operation;
  if (operation.status !== "prepared") {
    throw new VideoGenerationConflictError("Video generation is no longer awaiting acceptance");
  }
  const [policy] = await tx
    .select()
    .from(schema.workspaceVideoGenerationPolicies)
    .where(eq(schema.workspaceVideoGenerationPolicies.workspaceId, input.workspaceId))
    .for("share")
    .limit(1);
  const [connection] = operation.connectionId
    ? await tx
        .select({
          id: schema.connections.id,
          version: schema.connections.version,
          status: schema.connections.status,
          metadata: schema.connections.metadata,
        })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.workspaceId, input.workspaceId),
            eq(schema.connections.id, operation.connectionId),
          ),
        )
        .for("share")
        .limit(1)
    : [];
  const workspaceGatewayAuthorized =
    operation.fundingSource === "workspace_gateway" &&
    connection?.status === "active" &&
    connection.version === operation.credentialVersion &&
    connection.metadata.credentialRole === "vercel_ai_gateway";
  const managedAuthorized =
    operation.fundingSource === "opengeni_credits" &&
    operation.connectionId === null &&
    (operation.creditState === "debited" ||
      (operation.creditState === "not_applicable" && operation.pricedCostMicros === 0));
  if (
    !policy ||
    policy.fundingSource !== operation.fundingSource ||
    !policy.enabledModelIds.includes(operation.modelId) ||
    (!workspaceGatewayAuthorized && !managedAuthorized)
  ) {
    throw new VideoGenerationConflictError("Video generation authorization changed");
  }
  const now = new Date();
  const [updated] = await tx
    .update(schema.videoGenerationOperations)
    .set({
      status: "accepted",
      admissionOutputState: "recorded",
      terminalUpdateState: "pending",
      nextReconcileAt: now,
      updatedAt: now,
    })
    .where(eq(schema.videoGenerationOperations.id, operation.id))
    .returning();
  return requireRow(updated, "record video generation acceptance");
}

export async function cancelVideoGenerationBeforeSubmit(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    requestDigest: string;
    reason: string;
  },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status === "cancelled_before_submit") return operation;
    if (!inPreSubmitState(operation.status) || operation.providerRequestSentAt) {
      throw new VideoGenerationConflictError(
        "Video generation may already have reached the provider",
      );
    }
    const now = new Date();
    await releaseReservedQuota(tx, operation, false);
    const creditState = await refundVideoGenerationCredits(tx, operation, now);
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "cancelled_before_submit",
        creditState,
        quotaState: "released",
        terminalAt: now,
        terminalUpdateState:
          operation.admissionOutputState === "recorded" ? "pending" : "suppressed",
        credentialEncrypted: null,
        requestEncrypted: null,
        boundedPublicReason: boundPublicReason(input.reason),
        updatedAt: now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    if (!updated) throw new Error("Video generation cancellation was not recorded");
    return updated;
  });
}

/**
 * Turn-interruption half of pre-submit cancellation. It runs under the same
 * session/turn transaction that closes unresolved tool calls, so an accepted
 * receipt can never race a cancellation of its operation.
 */
export async function cancelUnacceptedVideoGenerationsForToolCallsInTransaction(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    toolCallIds: readonly string[];
    reason: string;
    now: Date;
  },
): Promise<string[]> {
  const toolCallIds = [...new Set(input.toolCallIds)];
  if (toolCallIds.length === 0) return [];
  const operations = await tx
    .select()
    .from(schema.videoGenerationOperations)
    .where(
      and(
        eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
        eq(schema.videoGenerationOperations.sessionId, input.sessionId),
        eq(schema.videoGenerationOperations.turnId, input.turnId),
        inArray(schema.videoGenerationOperations.toolCallId, toolCallIds),
        eq(schema.videoGenerationOperations.admissionOutputState, "pending"),
        inArray(schema.videoGenerationOperations.status, ["preparing", "prepared"]),
        sql`${schema.videoGenerationOperations.providerRequestSentAt} is null`,
      ),
    )
    .orderBy(schema.videoGenerationOperations.id)
    .for("update");
  const cancelled: string[] = [];
  for (const operation of operations) {
    await releaseReservedQuota(tx, operation, false);
    const creditState = await refundVideoGenerationCredits(tx, operation, input.now);
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "cancelled_before_submit",
        creditState,
        quotaState: "released",
        terminalAt: input.now,
        terminalUpdateState: "suppressed",
        nextReconcileAt: input.now,
        providerRequestEncrypted: null,
        providerRequestExpiresAt: null,
        credentialEncrypted: null,
        requestEncrypted: null,
        privateDataEraseAfter: input.now,
        boundedPublicReason: boundPublicReason(input.reason),
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning({ id: schema.videoGenerationOperations.id });
    if (!updated) throw new Error("Interrupted video generation was not cancelled");
    await tx
      .update(schema.videoGenerationReferences)
      .set({ cleanupAfter: input.now })
      .where(eq(schema.videoGenerationReferences.operationId, operation.id));
    cancelled.push(updated.id);
  }
  return cancelled;
}

export async function claimVideoGenerationOperations(
  db: Database,
  input: { owner: string; leaseSeconds: number; limit: number },
): Promise<Array<{ operationId: string; accountId: string; workspaceId: string }>> {
  const rows = await rawRows<{
    operation_id: string;
    account_id: string;
    workspace_id: string;
  }>(
    db,
    sql`select * from opengeni_private.claim_video_generation_operations(
      ${input.owner}, ${input.leaseSeconds}, ${input.limit}
    )`,
  );
  return rows.map((row) => ({
    operationId: row.operation_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
  }));
}

export async function getVideoGenerationOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<VideoGenerationOperationWithReferences | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [operation] = await scopedDb
      .select()
      .from(schema.videoGenerationOperations)
      .where(
        and(
          eq(schema.videoGenerationOperations.workspaceId, workspaceId),
          eq(schema.videoGenerationOperations.id, operationId),
        ),
      )
      .limit(1);
    if (!operation) return null;
    const references = await scopedDb
      .select()
      .from(schema.videoGenerationReferences)
      .where(eq(schema.videoGenerationReferences.operationId, operationId))
      .orderBy(schema.videoGenerationReferences.ordinal);
    return { ...operation, references };
  });
}

export async function markVideoGenerationSubmissionUncertain(
  db: Database,
  input: OperationMutationInput & { nextReconcileAt: Date; error: string },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status !== "submission_uncertain" || !operation.providerRequestEncrypted) {
      throw invalidTransition(operation, "submission_uncertain");
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "submission_uncertain",
        providerRequestSentAt: operation.providerRequestSentAt ?? now,
        nextReconcileAt: input.nextReconcileAt,
        lastError: boundPrivateError(input.error),
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    return requireRow(updated, "record uncertain video submission");
  });
}

/**
 * Freeze the exact provider start body before issuing the request. If the
 * worker disappears after this transaction, recovery replays the same body
 * and idempotency key rather than reminting URLs or changing request bytes.
 */
export async function markVideoGenerationSubmissionIntent(
  db: Database,
  input: OperationMutationInput & {
    encryptedProviderRequest: string;
    providerRequestExpiresAt: Date;
    nextReconcileAt: Date;
  },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status === "submission_uncertain") {
      if (!operation.providerRequestEncrypted || !operation.providerRequestExpiresAt) {
        throw new VideoGenerationConflictError("Video provider request is incomplete");
      }
      return operation;
    }
    if (operation.status !== "accepted") {
      throw invalidTransition(operation, "submission_uncertain");
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "submission_uncertain",
        providerRequestEncrypted: input.encryptedProviderRequest,
        providerRequestExpiresAt: input.providerRequestExpiresAt,
        nextReconcileAt: input.nextReconcileAt,
        lastError: null,
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    await tx
      .update(schema.videoGenerationReferences)
      .set({
        grantExpiresAt: input.providerRequestExpiresAt,
        cleanupAfter: new Date(
          Math.max(
            operation.recoveryDeadlineAt.getTime(),
            input.providerRequestExpiresAt.getTime(),
          ),
        ),
      })
      .where(eq(schema.videoGenerationReferences.operationId, operation.id));
    return requireRow(updated, "record video provider submission intent");
  });
}

export async function markVideoGenerationProviderStarted(
  db: Database,
  input: OperationMutationInput & { providerJobId: string; nextReconcileAt: Date },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (
      operation.providerJobId === input.providerJobId &&
      operation.status === "provider_started"
    ) {
      return operation;
    }
    if (!inArrayValue(operation.status, ["accepted", "submission_uncertain"])) {
      throw invalidTransition(operation, "provider_started");
    }
    const now = new Date();
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "provider_started",
        providerJobId: input.providerJobId.slice(0, 1_024),
        providerRequestEncrypted: null,
        providerRequestExpiresAt: null,
        providerRequestSentAt: operation.providerRequestSentAt ?? now,
        providerStartedAt: operation.providerStartedAt ?? now,
        nextReconcileAt: input.nextReconcileAt,
        lastError: null,
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    return requireRow(updated, "record video provider job");
  });
}

export async function rescheduleVideoGenerationOperation(
  db: Database,
  input: OperationMutationInput & { owner?: string; nextReconcileAt: Date; error?: string },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [updated] = await scopedDb
        .update(schema.videoGenerationOperations)
        .set({
          nextReconcileAt: input.nextReconcileAt,
          ...(input.error ? { lastError: boundPrivateError(input.error) } : {}),
          reconcileLeaseOwner: null,
          reconcileLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
            eq(schema.videoGenerationOperations.id, input.operationId),
            eq(schema.videoGenerationOperations.requestDigest, input.requestDigest),
            ...(input.owner
              ? [eq(schema.videoGenerationOperations.reconcileLeaseOwner, input.owner)]
              : []),
          ),
        )
        .returning({ id: schema.videoGenerationOperations.id });
      return updated !== undefined;
    },
  );
}

export async function markVideoGenerationRetaining(
  db: Database,
  input: OperationMutationInput,
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status === "retaining") return operation;
    if (operation.status !== "provider_started") throw invalidTransition(operation, "retaining");
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: "retaining",
        nextReconcileAt: new Date(),
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    return requireRow(updated, "begin video retention");
  });
}

export async function settleVideoGenerationFailure(
  db: Database,
  input: OperationMutationInput & {
    status: "provider_failed" | "retention_failed" | "outcome_unknown";
    publicReason: string;
    privateError?: string;
  },
): Promise<VideoGenerationOperation> {
  return await mutateOperation(db, input, async (tx, operation) => {
    if (operation.status === input.status) return operation;
    const allowed =
      input.status === "provider_failed"
        ? ["accepted", "submission_uncertain", "provider_started"]
        : input.status === "retention_failed"
          ? ["retaining"]
          : ["submission_uncertain", "provider_started"];
    if (!inArrayValue(operation.status, allowed)) throw invalidTransition(operation, input.status);
    await releaseReservedQuota(tx, operation, false);
    const now = new Date();
    const creditState = await refundVideoGenerationCredits(tx, operation, now);
    const [updated] = await tx
      .update(schema.videoGenerationOperations)
      .set({
        status: input.status,
        creditState,
        quotaState: "released",
        terminalAt: now,
        nextReconcileAt: null,
        terminalUpdateState:
          operation.admissionOutputState === "recorded" ? "pending" : "suppressed",
        providerRequestEncrypted: null,
        providerRequestExpiresAt: null,
        credentialEncrypted: null,
        requestEncrypted: null,
        boundedPublicReason: boundPublicReason(input.publicReason),
        lastError: input.privateError ? boundPrivateError(input.privateError) : null,
        reconcileLeaseOwner: null,
        reconcileLeaseExpiresAt: null,
        privateDataEraseAfter: now,
        updatedAt: now,
      })
      .where(eq(schema.videoGenerationOperations.id, operation.id))
      .returning();
    return requireRow(updated, "settle failed video generation");
  });
}

export type SettleVideoGenerationReadyInput = OperationMutationInput & {
  fileId: string;
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  facts: GeneratedVideoFacts;
};

export async function settleVideoGenerationReady(
  db: Database,
  input: SettleVideoGenerationReadyInput,
): Promise<{ operation: VideoGenerationOperation; artifact: GeneratedVideoArtifact }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [operation] = await tx
          .select()
          .from(schema.videoGenerationOperations)
          .where(
            and(
              eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
              eq(schema.videoGenerationOperations.id, input.operationId),
              eq(schema.videoGenerationOperations.requestDigest, input.requestDigest),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation) throw new VideoGenerationConflictError("Video operation not found");
        const [existingArtifact] = await tx
          .select()
          .from(schema.generatedVideoArtifacts)
          .where(eq(schema.generatedVideoArtifacts.operationId, operation.id))
          .limit(1);
        if (operation.status === "completed" && existingArtifact) {
          return { operation, artifact: existingArtifact };
        }
        if (operation.status !== "retaining") throw invalidTransition(operation, "completed");
        if (operation.expectedFileId !== input.fileId) {
          throw new VideoGenerationConflictError("Video File identity changed during settlement");
        }
        if (operation.expectedArtifactId === operation.expectedFileId) {
          throw new Error("Video artifact and File identities must be distinct");
        }
        const now = new Date();
        await tx.insert(schema.files).values({
          id: input.fileId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          status: "ready",
          filename: `generated-video-${operation.expectedArtifactId}.mp4`,
          safeFilename: `generated-video-${operation.expectedArtifactId}.mp4`,
          contentType: "video/mp4",
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          bucket: input.bucket,
          objectKey: input.objectKey,
          updatedAt: now,
        });
        const [artifact] = await tx
          .insert(schema.generatedVideoArtifacts)
          .values({
            id: operation.expectedArtifactId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            primaryFileId: input.fileId,
            operationId: operation.id,
            sessionId: operation.sessionId,
            turnId: operation.turnId,
            attemptId: operation.attemptId,
            modelId: operation.modelId,
            sourceMode: operation.sourceMode,
            promptDigest: operation.promptDigest,
            contentType: "video/mp4",
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            durationMillis: Math.round(input.facts.durationSeconds * 1_000),
            width: input.facts.width,
            height: input.facts.height,
            fpsMilli: Math.round(input.facts.fps * 1_000),
            videoCodec: input.facts.videoCodec,
            audioCodec: input.facts.audioCodec,
            hasAudio: input.facts.hasAudio,
            sandboxFilename: `generated-video-${operation.expectedArtifactId}.mp4`,
            readyAt: now,
          })
          .returning();
        if (!artifact) throw new Error("Generated video artifact was not persisted");
        await tx
          .update(schema.workspaceVideoGenerationQuotas)
          .set({
            reservedBytes: sql`${schema.workspaceVideoGenerationQuotas.reservedBytes} - ${operation.reservedBytes}`,
            readyBytes: sql`${schema.workspaceVideoGenerationQuotas.readyBytes} + ${input.sizeBytes}`,
            updatedAt: now,
          })
          .where(eq(schema.workspaceVideoGenerationQuotas.workspaceId, input.workspaceId));
        const [updated] = await tx
          .update(schema.videoGenerationOperations)
          .set({
            status: "completed",
            quotaState: "ready",
            terminalAt: now,
            nextReconcileAt: null,
            terminalUpdateState:
              operation.admissionOutputState === "recorded" ? "pending" : "suppressed",
            providerRequestEncrypted: null,
            providerRequestExpiresAt: null,
            credentialEncrypted: null,
            requestEncrypted: null,
            privateDataEraseAfter: now,
            reconcileLeaseOwner: null,
            reconcileLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(schema.videoGenerationOperations.id, operation.id))
          .returning();
        return {
          operation: requireRow(updated, "settle ready video generation"),
          artifact,
        };
      }),
  );
}

export async function getGeneratedVideoArtifact(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<{ artifact: GeneratedVideoArtifact; file: typeof schema.files.$inferSelect } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ artifact: schema.generatedVideoArtifacts, file: schema.files })
      .from(schema.generatedVideoArtifacts)
      .innerJoin(schema.files, eq(schema.files.id, schema.generatedVideoArtifacts.primaryFileId))
      .where(
        and(
          eq(schema.generatedVideoArtifacts.workspaceId, workspaceId),
          eq(schema.generatedVideoArtifacts.id, artifactId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function listSessionGeneratedVideoArtifacts(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<Array<{ artifact: GeneratedVideoArtifact; file: typeof schema.files.$inferSelect }>> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select({ artifact: schema.generatedVideoArtifacts, file: schema.files })
        .from(schema.generatedVideoArtifacts)
        .innerJoin(schema.files, eq(schema.files.id, schema.generatedVideoArtifacts.primaryFileId))
        .where(
          and(
            eq(schema.generatedVideoArtifacts.workspaceId, workspaceId),
            eq(schema.generatedVideoArtifacts.sessionId, sessionId),
            sql`${schema.generatedVideoArtifacts.deletedAt} is null`,
          ),
        )
        .orderBy(schema.generatedVideoArtifacts.createdAt, schema.generatedVideoArtifacts.id),
  );
}

/**
 * Record one staging object as erased only after the object-store delete has
 * succeeded. Deleting first is safe because object deletion is idempotent; a
 * crash before this CAS simply repeats the same delete on recovery.
 */
export async function markVideoGenerationReferenceCleaned(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    ordinal: number;
    stagingObjectKey: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [updated] = await scopedDb
        .update(schema.videoGenerationReferences)
        .set({
          stagingObjectKey: null,
          grantExpiresAt: null,
          cleanupAfter: null,
          cleanedAt: new Date(),
        })
        .where(
          and(
            eq(schema.videoGenerationReferences.workspaceId, input.workspaceId),
            eq(schema.videoGenerationReferences.operationId, input.operationId),
            eq(schema.videoGenerationReferences.ordinal, input.ordinal),
            eq(schema.videoGenerationReferences.stagingObjectKey, input.stagingObjectKey),
          ),
        )
        .returning({ operationId: schema.videoGenerationReferences.operationId });
      if (updated) return true;
      const [existing] = await scopedDb
        .select({ cleanedAt: schema.videoGenerationReferences.cleanedAt })
        .from(schema.videoGenerationReferences)
        .where(
          and(
            eq(schema.videoGenerationReferences.workspaceId, input.workspaceId),
            eq(schema.videoGenerationReferences.operationId, input.operationId),
            eq(schema.videoGenerationReferences.ordinal, input.ordinal),
          ),
        )
        .limit(1);
      return existing?.cleanedAt !== null && existing?.cleanedAt !== undefined;
    },
  );
}

export async function markVideoGenerationTerminalUpdate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    state: "leased" | "delivered" | "suppressed";
    updateId?: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await markVideoGenerationTerminalUpdateInTransaction(scopedDb, input);
    },
  );
}

export async function markVideoGenerationTerminalUpdateInTransaction(
  tx: Database,
  input: {
    workspaceId: string;
    operationId: string;
    state: "leased" | "delivered" | "suppressed";
    updateId?: string;
  },
): Promise<boolean> {
  const allowed =
    input.state === "leased"
      ? ["pending", "leased"]
      : input.state === "delivered"
        ? ["leased"]
        : ["pending", "leased"];
  const [updated] = await tx
    .update(schema.videoGenerationOperations)
    .set({
      terminalUpdateState: input.state,
      terminalUpdateId: input.state === "suppressed" ? null : (input.updateId ?? null),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
        eq(schema.videoGenerationOperations.id, input.operationId),
        inArray(schema.videoGenerationOperations.terminalUpdateState, allowed),
        ...(input.state === "delivered" && input.updateId
          ? [eq(schema.videoGenerationOperations.terminalUpdateId, input.updateId)]
          : []),
      ),
    )
    .returning({ id: schema.videoGenerationOperations.id });
  return updated !== undefined;
}

export function mediaGenerationResultForOperation(input: {
  operation: VideoGenerationOperation;
  readyReceipt?: Extract<MediaGenerationResult, { status: "ready" }>["receipt"];
}): MediaGenerationResult {
  if (input.operation.status === "completed" && input.readyReceipt) {
    return {
      type: "media_generation_result",
      schemaVersion: 1,
      status: "ready",
      operationId: input.operation.id,
      receipt: input.readyReceipt,
    };
  }
  const failureStatus = input.operation.status;
  if (
    !inArrayValue(failureStatus, [
      "provider_failed",
      "retention_failed",
      "cancelled_before_submit",
      "outcome_unknown",
    ])
  ) {
    throw new Error("Video generation operation is not terminal");
  }
  return {
    type: "media_generation_result",
    schemaVersion: 1,
    status: failureStatus,
    operationId: input.operation.id,
    boundedPublicReason:
      input.operation.boundedPublicReason ?? "Video generation did not complete.",
  } as MediaGenerationResult;
}

/** Build the compact public/model terminal envelope from durable canonical rows. */
export async function mediaGenerationResultForStoredOperation(
  db: Database,
  operation: VideoGenerationOperation,
): Promise<MediaGenerationResult> {
  if (operation.status !== "completed") {
    return mediaGenerationResultForOperation({ operation });
  }
  const retained = await getGeneratedVideoArtifact(
    db,
    operation.workspaceId,
    operation.expectedArtifactId,
  );
  if (!retained || retained.artifact.deletedAt) {
    throw new Error("Completed video generation lost its retained artifact");
  }
  const artifact = retainedGeneratedVideoReferenceFromFile({
    id: retained.artifact.id,
    workspaceId: retained.artifact.workspaceId,
    status: retained.file.status,
    contentType: retained.file.contentType,
    sizeBytes: retained.file.sizeBytes,
    sha256: retained.file.sha256,
    updatedAt: retained.artifact.readyAt.toISOString(),
    width: retained.artifact.width,
    height: retained.artifact.height,
  });
  if (!artifact) throw new Error("Generated video receipt could not be constructed");
  const receipt = GeneratedVideoReceipt.parse({
    type: "generated_video",
    schemaVersion: 1,
    operationId: operation.id,
    artifact,
    video: {
      durationSeconds: retained.artifact.durationMillis / 1_000,
      width: retained.artifact.width,
      height: retained.artifact.height,
      fps: retained.artifact.fpsMilli / 1_000,
      hasAudio: retained.artifact.hasAudio,
      videoCodec: retained.artifact.videoCodec,
      audioCodec: retained.artifact.audioCodec,
    },
    sandboxPath: `/workspace/generated-videos/${retained.artifact.sandboxFilename}`,
  });
  return mediaGenerationResultForOperation({ operation, readyReceipt: receipt });
}

export async function getVideoGenerationOperationSummary(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<import("@opengeni/contracts").VideoGenerationOperationSummary | null> {
  const operation = await getVideoGenerationOperation(db, workspaceId, operationId);
  if (!operation) return null;
  const terminal = inArrayValue(operation.status, [
    "completed",
    "provider_failed",
    "cancelled_before_submit",
    "outcome_unknown",
    "retention_failed",
  ])
    ? await mediaGenerationResultForStoredOperation(db, operation)
    : null;
  return VideoGenerationOperationSummary.parse({
    schemaVersion: 1,
    operationId: operation.id,
    modelId: operation.modelId,
    status: operation.status === "submission_uncertain" ? "accepted" : operation.status,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    terminal,
  });
}

type OperationMutationInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  requestDigest: string;
};

async function mutateOperation<T>(
  db: Database,
  input: OperationMutationInput,
  mutate: (tx: Database, operation: VideoGenerationOperation) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [operation] = await tx
          .select()
          .from(schema.videoGenerationOperations)
          .where(
            and(
              eq(schema.videoGenerationOperations.workspaceId, input.workspaceId),
              eq(schema.videoGenerationOperations.id, input.operationId),
              eq(schema.videoGenerationOperations.requestDigest, input.requestDigest),
            ),
          )
          .for("update")
          .limit(1);
        if (!operation) throw new VideoGenerationConflictError("Video operation not found");
        return await mutate(tx, operation);
      }),
  );
}

async function releaseReservedQuota(
  tx: Database,
  operation: VideoGenerationOperation,
  ready: boolean,
): Promise<void> {
  if (operation.quotaState !== "reserved") return;
  await tx
    .update(schema.workspaceVideoGenerationQuotas)
    .set({
      reservedBytes: sql`${schema.workspaceVideoGenerationQuotas.reservedBytes} - ${operation.reservedBytes}`,
      ...(ready
        ? {
            readyBytes: sql`${schema.workspaceVideoGenerationQuotas.readyBytes} + ${operation.reservedBytes}`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaceVideoGenerationQuotas.workspaceId, operation.workspaceId));
}

async function debitVideoGenerationCredits(
  tx: Database,
  operation: VideoGenerationOperation,
): Promise<void> {
  if (operation.pricedCostMicros <= 0 || operation.fundingSource !== "opengeni_credits") {
    throw new Error("Managed video credit debit has an invalid funding binding");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.accountId}))`);
  const [balanceRow] = await tx
    .select({
      balanceMicros: sql<number>`coalesce(sum(${schema.creditLedgerEntries.amountMicros}), 0)`,
    })
    .from(schema.creditLedgerEntries)
    .where(eq(schema.creditLedgerEntries.accountId, operation.accountId));
  const balanceMicros = Number(balanceRow?.balanceMicros ?? 0);
  if (!Number.isSafeInteger(balanceMicros) || balanceMicros < operation.pricedCostMicros) {
    throw new VideoGenerationCreditError();
  }
  const now = new Date();
  const inserted = await tx
    .insert(schema.creditLedgerEntries)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      type: "video_generation_debit",
      amountMicros: -operation.pricedCostMicros,
      sourceType: "video_generation_operation",
      sourceId: operation.id,
      idempotencyKey: `credit:video_generation_debit:${operation.id}`,
      metadata: {
        modelId: operation.modelId,
        sourceMode: operation.sourceMode,
        pricedCostMicros: operation.pricedCostMicros,
      },
      occurredAt: now,
    })
    .onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey })
    .returning({ id: schema.creditLedgerEntries.id });
  if (inserted.length !== 1) {
    throw new VideoGenerationConflictError("Video generation credit debit already exists");
  }
  await tx
    .insert(schema.usageEvents)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      eventType: "video_generation.cost",
      quantity: operation.pricedCostMicros,
      unit: "usd_micros",
      sourceResourceType: "video_generation_operation",
      sourceResourceId: operation.id,
      sessionId: operation.sessionId,
      turnId: operation.turnId,
      turnAttemptId: operation.attemptId,
      idempotencyKey: `usage:video_generation.cost:${operation.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey });
}

async function refundVideoGenerationCredits(
  tx: Database,
  operation: VideoGenerationOperation,
  now: Date,
): Promise<VideoGenerationOperation["creditState"]> {
  if (operation.creditState !== "debited") return operation.creditState;
  if (operation.fundingSource !== "opengeni_credits" || operation.pricedCostMicros <= 0) {
    throw new Error("Video generation credit refund has an invalid funding binding");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.accountId}))`);
  const inserted = await tx
    .insert(schema.creditLedgerEntries)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      type: "video_generation_refund",
      amountMicros: operation.pricedCostMicros,
      sourceType: "video_generation_operation",
      sourceId: operation.id,
      idempotencyKey: `credit:video_generation_refund:${operation.id}`,
      metadata: {
        modelId: operation.modelId,
        sourceMode: operation.sourceMode,
        pricedCostMicros: operation.pricedCostMicros,
      },
      occurredAt: now,
    })
    .onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey })
    .returning({ id: schema.creditLedgerEntries.id });
  if (inserted.length !== 1) {
    throw new VideoGenerationConflictError("Video generation credit refund already exists");
  }
  await tx
    .insert(schema.usageEvents)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      eventType: "video_generation.refund",
      quantity: operation.pricedCostMicros,
      unit: "usd_micros",
      sourceResourceType: "video_generation_operation",
      sourceResourceId: operation.id,
      sessionId: operation.sessionId,
      turnId: operation.turnId,
      turnAttemptId: operation.attemptId,
      idempotencyKey: `usage:video_generation.refund:${operation.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey });
  return "refunded";
}

function policyFromRow(
  row: typeof schema.workspaceVideoGenerationPolicies.$inferSelect | undefined,
): VideoGenerationPolicyValue {
  return VideoGenerationPolicy.parse(
    row
      ? {
          schemaVersion: 1,
          revision: row.revision,
          fundingSource: row.fundingSource,
          enabledModelIds: row.enabledModelIds,
          defaultModelId: row.defaultModelId,
        }
      : {
          schemaVersion: 1,
          revision: 0,
          fundingSource: "workspace_gateway",
          enabledModelIds: [],
          defaultModelId: null,
        },
  );
}

function assertSupportedModels(modelIds: readonly string[]): void {
  for (const modelId of modelIds) {
    if (modelId !== SEEDANCE_2_5_MODEL_ID) {
      throw new Error(`Unknown video generation model: ${modelId}`);
    }
  }
}

function assertAdmissionMatches(
  operation: VideoGenerationOperation,
  input: AdmitVideoGenerationOperationInput,
): void {
  if (
    operation.requestDigest !== input.requestDigest ||
    operation.toolCallId !== input.toolCallId ||
    operation.sessionId !== input.sessionId ||
    operation.turnId !== input.turnId ||
    operation.fundingSource !== input.fundingSource ||
    operation.pricedCostMicros !== input.pricedCostMicros
  ) {
    throw new VideoGenerationConflictError(
      "Video generation admission key was reused with different arguments",
    );
  }
}

function inPreSubmitState(status: string): boolean {
  return inArrayValue(status, ["preparing", "prepared", "accepted"]);
}

function inArrayValue<T extends string>(value: string, candidates: readonly T[]): value is T {
  return (candidates as readonly string[]).includes(value);
}

function invalidTransition(operation: VideoGenerationOperation, target: string): Error {
  return new VideoGenerationConflictError(
    `Invalid video generation transition ${operation.status} -> ${target}`,
  );
}

function requireRow<T>(value: T | undefined, action: string): T {
  if (!value) throw new Error(`Failed to ${action}`);
  return value;
}

function boundPublicReason(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return (normalized || "Video generation did not complete.").slice(0, 1_000);
}

function boundPrivateError(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 4_096);
}
