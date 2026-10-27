import type { FileAsset, FileStatus, FileUploadStatus } from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext, withWorkspaceRls } from "./database";
import * as schema from "./schema";
import { lockSessionEventWriteRows } from "./session-control";
import { checkWorkspaceAllowance } from "./usage-allowances";
import { creditDebitAttributionForTurn } from "./credit-debit-attribution";
import {
  getBillingBalance,
  getSpendableCreditBalance,
  planPostUseCreditAllocations,
} from "./credit-balances";
import { beginPlanCreditSettlement } from "./subscription-plans";

export type GeneratedImageSourceStrategy = "native_hosted" | "provider_adapter";
export type GeneratedImageArtifactStatus = "pending" | "ready";
export type ImageGenerationOperationStatus =
  | "prepared"
  | "provider_started"
  | "completed"
  | "outcome_unknown"
  | "retention_failed";
export type ImageGenerationCreditState = "not_applicable" | "pending" | "debited";
export type ImageGenerationCreditRefusalCode = "insufficient_credits" | "allowance_exhausted";

/**
 * Opengeni credits refused a priced image before any provider request. The
 * message is plain enough to show the person as-is.
 */
export class ImageGenerationCreditError extends Error {
  constructor(
    message = "this workspace doesn't have enough Opengeni credits left for it",
    readonly code: ImageGenerationCreditRefusalCode = "insufficient_credits",
  ) {
    super(message);
    this.name = "ImageGenerationCreditError";
  }
}

/**
 * A priced image still in its provider request holds its price against the
 * workspace's credits, so parallel images cannot all pass admission on one
 * balance. A request this old has crashed or timed out and stops holding it.
 */
const IMAGE_GENERATION_CREDIT_HOLD_WINDOW = "15 minutes";

export type ImageGenerationOperation = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string | null;
  turnId: string | null;
  attemptId: string | null;
  operationKey: string;
  toolCallId: string;
  providerId: string;
  providerBindingHash: string;
  modelId: string;
  requestDigest: string;
  expectedArtifactId: string;
  status: ImageGenerationOperationStatus;
  pricedCostMicros: number;
  creditState: ImageGenerationCreditState;
  /**
   * The turn's canonical chat model, frozen with the price. Plan and trial
   * grants that cover that model pay for the image as they pay for the chat.
   */
  creditUsageModelId: string | null;
  providerStartedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GeneratedImageArtifact = {
  artifactId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string | null;
  turnId: string | null;
  attemptId: string | null;
  uploadId: string | null;
  settlementKey: string;
  toolCallId: string;
  sourceStrategy: GeneratedImageSourceStrategy;
  providerId: string;
  providerBindingHash: string;
  providerItemId: string | null;
  status: GeneratedImageArtifactStatus;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  sandboxPath: string;
  readyAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  uploadStatus: FileUploadStatus | null;
  file: FileAsset;
};

export type PrepareGeneratedImageArtifactInput = {
  artifactId: string;
  uploadId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  settlementKey: string;
  toolCallId: string;
  sourceStrategy: GeneratedImageSourceStrategy;
  providerId: string;
  providerBindingHash: string;
  providerItemId: string | null;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  sandboxPath: string;
  filename: string;
  safeFilename: string;
  bucket: string;
  objectKey: string;
  uploadExpiresAt: Date;
};

export type PrepareImageGenerationOperationInput = Omit<
  ImageGenerationOperation,
  | "status"
  | "pricedCostMicros"
  | "creditState"
  | "creditUsageModelId"
  | "providerStartedAt"
  | "completedAt"
  | "lastError"
  | "createdAt"
  | "updatedAt"
> & {
  /** Opengeni-credit customer price; zero or omitted when credits do not fund it. */
  pricedCostMicros?: number;
  /** The turn's canonical chat model whose plan and trial grants may pay. */
  creditUsageModelId?: string;
};

export async function prepareImageGenerationOperation(
  db: Database,
  input: PrepareImageGenerationOperationInput,
): Promise<{ operation: ImageGenerationOperation; created: boolean }> {
  const credit = imageGenerationCreditFields(
    input.pricedCostMicros ?? 0,
    input.creditUsageModelId ?? null,
  );
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // FK triggers can KEY SHARE the attempt before the turn, depending on
        // catalog history. Take the lifecycle prefix before operation locks so
        // reservation cannot invert a concurrent turn -> attempt writer.
        await lockSessionEventWriteRows(tx, {
          workspaceId: input.workspaceId,
          controlLock: "none",
          sessionIds: input.sessionId ? [input.sessionId] : [],
          turnIds: input.turnId ? [input.turnId] : [],
          attemptIds: input.attemptId ? [input.attemptId] : [],
        });
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`image-generation-operation:${input.operationKey}`}, 0))`,
        );
        const existing = await imageGenerationOperationByKeyTx(
          tx,
          input.workspaceId,
          input.operationKey,
        );
        if (existing) {
          assertImageGenerationOperationStableFieldsMatch(existing, input);
          const bindingChanged = existing.providerBindingHash !== input.providerBindingHash;
          const artifactChanged = existing.expectedArtifactId !== input.expectedArtifactId;
          if (!bindingChanged && !artifactChanged) {
            return { operation: existing, created: false };
          }
          if (existing.status !== "prepared" || !bindingChanged || !artifactChanged) {
            throw new Error("Image generation retry does not match the reserved operation");
          }
          // A provider failover before dispatch also moves the funding: the
          // reserved price follows the binding that will actually execute.
          const [row] = await tx
            .update(schema.imageGenerationOperations)
            .set({
              providerBindingHash: input.providerBindingHash,
              expectedArtifactId: input.expectedArtifactId,
              ...credit,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.imageGenerationOperations.id, existing.id),
                eq(schema.imageGenerationOperations.status, "prepared"),
              ),
            )
            .returning();
          if (!row) throw new Error("Image generation retry does not match the reserved operation");
          return { operation: mapImageGenerationOperation(row), created: false };
        }
        const [row] = await tx
          .insert(schema.imageGenerationOperations)
          .values({ ...input, ...credit, status: "prepared" })
          .returning();
        if (!row) throw new Error("Failed to prepare image generation operation");
        return { operation: mapImageGenerationOperation(row), created: true };
      }),
  );
}

export async function getImageGenerationOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<ImageGenerationOperation | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.imageGenerationOperations)
      .where(
        and(
          eq(schema.imageGenerationOperations.workspaceId, workspaceId),
          eq(schema.imageGenerationOperations.id, operationId),
        ),
      )
      .limit(1);
    return row ? mapImageGenerationOperation(row) : null;
  });
}

export async function beginImageGenerationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
    providerBindingHash: string;
    expectedArtifactId: string;
  },
): Promise<{ operation: ImageGenerationOperation; started: boolean }> {
  let started = false;
  const operation = await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status !== "prepared") return current;
    if (
      current.providerBindingHash !== input.providerBindingHash ||
      current.expectedArtifactId !== input.expectedArtifactId
    ) {
      throw new Error("Image generation operation binding changed before provider dispatch");
    }
    // Opengeni credits must admit a priced image before its provider request.
    // A refusal rolls back and leaves the operation `prepared`: nothing was
    // dispatched or charged.
    if (current.pricedCostMicros > 0) await admitImageGenerationCredits(tx, current);
    const now = new Date();
    const [row] = await tx
      .update(schema.imageGenerationOperations)
      .set({
        status: "provider_started",
        providerStartedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.imageGenerationOperations.id, current.id))
      .returning();
    if (!row) throw new Error("Failed to begin image generation operation");
    started = true;
    return mapImageGenerationOperation(row);
  });
  return { operation, started };
}

/**
 * Return a paid-operation row to its retryable prepared state when a durable
 * provider-dispatch fence rejected before any provider request was admitted.
 * This is intentionally narrower than outcome reconciliation: a caller must
 * prove the provider boundary was never crossed, or that the provider refused
 * the request outright without doing paid work, before using this transition.
 */
export async function resetImageGenerationOperationBeforeProviderDispatch(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
    error: string;
  },
): Promise<ImageGenerationOperation> {
  return await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status !== "provider_started") return current;
    const [row] = await tx
      .update(schema.imageGenerationOperations)
      .set({
        status: "prepared",
        providerStartedAt: null,
        completedAt: null,
        lastError: input.error.slice(0, 4_096),
        updatedAt: new Date(),
      })
      .where(eq(schema.imageGenerationOperations.id, current.id))
      .returning();
    if (!row)
      throw new Error("Failed to reset image generation operation before provider dispatch");
    return mapImageGenerationOperation(row);
  });
}

export async function markImageGenerationOperationOutcomeUnknown(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
    error: string;
  },
): Promise<ImageGenerationOperation> {
  return await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status !== "provider_started") return current;
    const [row] = await tx
      .update(schema.imageGenerationOperations)
      .set({
        status: "outcome_unknown",
        lastError: input.error.slice(0, 4_096),
        updatedAt: new Date(),
      })
      .where(eq(schema.imageGenerationOperations.id, current.id))
      .returning();
    if (!row) throw new Error("Failed to fence ambiguous image generation operation");
    return mapImageGenerationOperation(row);
  });
}

/** Provider completed, but its bytes could not be durably retained. Never replay the paid call. */
export async function markImageGenerationOperationRetentionFailed(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
    error: string;
  },
): Promise<ImageGenerationOperation> {
  return await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status !== "provider_started") return current;
    const [row] = await tx
      .update(schema.imageGenerationOperations)
      .set({
        status: "retention_failed",
        lastError: input.error.slice(0, 4_096),
        updatedAt: new Date(),
      })
      .where(eq(schema.imageGenerationOperations.id, current.id))
      .returning();
    if (!row) throw new Error("Failed to record generated image retention failure");
    return mapImageGenerationOperation(row);
  });
}

export async function completeImageGenerationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
  },
): Promise<ImageGenerationOperation> {
  return await mutateImageGenerationOperation(db, input, completeImageGenerationOperationTx);
}

async function completeImageGenerationOperationTx(
  tx: Database,
  current: ImageGenerationOperation,
): Promise<ImageGenerationOperation> {
  if (current.status === "completed") return current;
  if (
    current.status !== "provider_started" &&
    current.status !== "outcome_unknown" &&
    current.status !== "retention_failed"
  ) {
    throw new Error("Image generation operation did not reach the provider");
  }
  const [artifact] = await tx
    .select({
      artifact: schema.generatedImageArtifacts,
      file: schema.files,
    })
    .from(schema.generatedImageArtifacts)
    .innerJoin(schema.files, eq(schema.files.id, schema.generatedImageArtifacts.artifactId))
    .where(
      and(
        eq(schema.generatedImageArtifacts.workspaceId, current.workspaceId),
        eq(schema.generatedImageArtifacts.artifactId, current.expectedArtifactId),
      ),
    )
    .limit(1);
  if (
    !artifact ||
    artifact.artifact.status !== "ready" ||
    artifact.file.status !== "ready" ||
    artifact.artifact.sourceStrategy !== "provider_adapter" ||
    artifact.artifact.sessionId !== current.sessionId ||
    artifact.artifact.turnId !== current.turnId ||
    artifact.artifact.toolCallId !== current.toolCallId ||
    artifact.artifact.providerId !== current.providerId ||
    artifact.artifact.providerBindingHash !== current.providerBindingHash ||
    artifact.artifact.providerItemId !== null
  ) {
    throw new Error("Image generation operation has no durable ready artifact");
  }
  // The delivered image and its one credit debit commit together. An
  // admitted image is charged even if the balance changed since admission.
  const creditState =
    current.creditState === "pending"
      ? await debitImageGenerationCredits(tx, current)
      : current.creditState;
  const now = new Date();
  const [row] = await tx
    .update(schema.imageGenerationOperations)
    .set({
      status: "completed",
      creditState,
      completedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(schema.imageGenerationOperations.id, current.id))
    .returning();
  if (!row) throw new Error("Failed to complete image generation operation");
  return mapImageGenerationOperation(row);
}

/**
 * Reserve one deterministic file/upload/correlation triple. Concurrent retries
 * converge on the same identities and must agree on every immutable byte fact.
 */
export async function prepareGeneratedImageArtifact(
  db: Database,
  input: PrepareGeneratedImageArtifactInput,
): Promise<{ artifact: GeneratedImageArtifact; created: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // Artifact correlation has the same turn/attempt FK edges as operation
        // reservation. Acquire parents before either file rows or settlement
        // locks, following the canonical lifecycle order rather than FK order.
        await lockSessionEventWriteRows(tx, {
          workspaceId: input.workspaceId,
          controlLock: "none",
          sessionIds: [input.sessionId],
          turnIds: [input.turnId],
          attemptIds: [input.attemptId],
        });
        // `settlementKey` is the durable provider-operation identity. Serializing
        // that key makes concurrent Temporal/activity retries converge
        // without relying on unique-violation recovery across three tables.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`generated-image:${input.settlementKey}`}, 0))`,
        );
        const existing = await generatedImageArtifactBySettlementTx(
          tx,
          input.workspaceId,
          input.settlementKey,
        );
        if (existing) {
          assertPreparedArtifactMatches(existing, input);
          return { artifact: existing, created: false };
        }

        const [file] = await tx
          .insert(schema.files)
          .values({
            id: input.artifactId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            filename: input.filename,
            safeFilename: input.safeFilename,
            contentType: input.mediaType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            bucket: input.bucket,
            objectKey: input.objectKey,
            status: "pending_upload",
          })
          .returning();
        if (!file) throw new Error("Failed to create generated image file");

        const [upload] = await tx
          .insert(schema.fileUploads)
          .values({
            id: input.uploadId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            fileId: input.artifactId,
            status: "pending",
            expiresAt: input.uploadExpiresAt,
          })
          .returning();
        if (!upload) throw new Error("Failed to create generated image upload");

        const [artifactRow] = await tx
          .insert(schema.generatedImageArtifacts)
          .values({
            artifactId: input.artifactId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            uploadId: input.uploadId,
            settlementKey: input.settlementKey,
            toolCallId: input.toolCallId,
            sourceStrategy: input.sourceStrategy,
            providerId: input.providerId,
            providerBindingHash: input.providerBindingHash,
            providerItemId: input.providerItemId,
            status: "pending",
            mediaType: input.mediaType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            width: input.width,
            height: input.height,
            sandboxPath: input.sandboxPath,
          })
          .returning();
        if (!artifactRow) throw new Error("Failed to create generated image artifact");
        return {
          artifact: mapGeneratedImageArtifact(artifactRow, file, upload.status),
          created: true,
        };
      }),
  );
}

export async function getGeneratedImageArtifact(
  db: Database,
  workspaceId: string,
  artifactId: string,
): Promise<GeneratedImageArtifact | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await generatedImageArtifactByIdTx(scopedDb, workspaceId, artifactId);
  });
}

/** Metadata only. Callers must separately prove file read authority for every id. */
export async function getGeneratedImageArtifacts(
  db: Database,
  workspaceId: string,
  artifactIds: readonly string[],
): Promise<GeneratedImageArtifact[]> {
  const ids = [...new Set(artifactIds)];
  if (ids.length === 0) return [];
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({
        artifact: schema.generatedImageArtifacts,
        file: schema.files,
        uploadStatus: schema.fileUploads.status,
      })
      .from(schema.generatedImageArtifacts)
      .innerJoin(
        schema.files,
        and(
          eq(schema.files.workspaceId, schema.generatedImageArtifacts.workspaceId),
          eq(schema.files.id, schema.generatedImageArtifacts.artifactId),
        ),
      )
      .leftJoin(
        schema.fileUploads,
        eq(schema.fileUploads.id, schema.generatedImageArtifacts.uploadId),
      )
      .where(
        and(
          eq(schema.generatedImageArtifacts.workspaceId, workspaceId),
          inArray(schema.generatedImageArtifacts.artifactId, ids),
        ),
      );
    return rows.map((row) => mapGeneratedImageArtifact(row.artifact, row.file, row.uploadStatus));
  });
}

export async function settleGeneratedImageArtifactReady(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    artifactId: string;
    settlementKey: string;
    /**
     * The adapter operation that produced this image. It completes, and a
     * priced image is debited, in the same transaction that makes the image
     * ready, so no crash can leave a delivered image uncharged.
     */
    operation?: { operationId: string; operationKey: string };
  },
): Promise<GeneratedImageArtifact> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schema.generatedImageArtifacts)
          .where(
            and(
              eq(schema.generatedImageArtifacts.workspaceId, input.workspaceId),
              eq(schema.generatedImageArtifacts.artifactId, input.artifactId),
            ),
          )
          .for("update")
          .limit(1);
        if (!locked || locked.settlementKey !== input.settlementKey) {
          throw new Error("Generated image settlement identity does not match");
        }
        const existing = await generatedImageArtifactByIdTx(
          tx,
          input.workspaceId,
          input.artifactId,
        );
        if (!existing) throw new Error("Generated image settlement file is missing");
        if (existing.status === "ready") {
          if (input.operation) {
            await completeImageGenerationOperationForArtifactTx(tx, input, input.operation);
          }
          return existing;
        }
        if (existing.file.status !== "ready" || existing.uploadStatus !== "completed") {
          throw new Error("Generated image file is not durably ready");
        }
        const now = new Date();
        await tx
          .update(schema.generatedImageArtifacts)
          .set({
            status: "ready",
            readyAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.generatedImageArtifacts.workspaceId, input.workspaceId),
              eq(schema.generatedImageArtifacts.artifactId, input.artifactId),
              eq(schema.generatedImageArtifacts.status, "pending"),
            ),
          );
        const settled = await generatedImageArtifactByIdTx(tx, input.workspaceId, input.artifactId);
        if (!settled || settled.status !== "ready") {
          throw new Error("Generated image settlement was superseded");
        }
        if (input.operation) {
          await completeImageGenerationOperationForArtifactTx(tx, input, input.operation);
        }
        return settled;
      }),
  );
}

/** Lock order: artifact (held by the caller), then operation, then account. */
async function completeImageGenerationOperationForArtifactTx(
  tx: Database,
  artifact: { workspaceId: string; artifactId: string },
  identity: { operationId: string; operationKey: string },
): Promise<void> {
  const [row] = await tx
    .select()
    .from(schema.imageGenerationOperations)
    .where(
      and(
        eq(schema.imageGenerationOperations.workspaceId, artifact.workspaceId),
        eq(schema.imageGenerationOperations.id, identity.operationId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !row ||
    row.operationKey !== identity.operationKey ||
    row.expectedArtifactId !== artifact.artifactId
  ) {
    throw new Error("Generated image does not belong to its image generation operation");
  }
  await completeImageGenerationOperationTx(tx, mapImageGenerationOperation(row));
}

export async function recordGeneratedImageArtifactError(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    artifactId: string;
    settlementKey: string;
    error: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .update(schema.generatedImageArtifacts)
        .set({ lastError: input.error.slice(0, 4_096), updatedAt: new Date() })
        .where(
          and(
            eq(schema.generatedImageArtifacts.workspaceId, input.workspaceId),
            eq(schema.generatedImageArtifacts.artifactId, input.artifactId),
            eq(schema.generatedImageArtifacts.settlementKey, input.settlementKey),
            eq(schema.generatedImageArtifacts.status, "pending"),
          ),
        );
    },
  );
}

export async function listReadyGeneratedImageArtifactsForSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<GeneratedImageArtifact[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        artifact: schema.generatedImageArtifacts,
        file: schema.files,
        uploadStatus: schema.fileUploads.status,
      })
      .from(schema.generatedImageArtifacts)
      .innerJoin(
        schema.files,
        and(
          eq(schema.files.workspaceId, schema.generatedImageArtifacts.workspaceId),
          eq(schema.files.id, schema.generatedImageArtifacts.artifactId),
        ),
      )
      .leftJoin(
        schema.fileUploads,
        eq(schema.fileUploads.id, schema.generatedImageArtifacts.uploadId),
      )
      .where(
        and(
          eq(schema.generatedImageArtifacts.workspaceId, workspaceId),
          eq(schema.generatedImageArtifacts.sessionId, sessionId),
          eq(schema.generatedImageArtifacts.status, "ready"),
        ),
      );
    return rows.map((row) => mapGeneratedImageArtifact(row.artifact, row.file, row.uploadStatus));
  });
}

async function generatedImageArtifactBySettlementTx(
  tx: Database,
  workspaceId: string,
  settlementKey: string,
): Promise<GeneratedImageArtifact | null> {
  const [row] = await tx
    .select({
      artifact: schema.generatedImageArtifacts,
      file: schema.files,
      uploadStatus: schema.fileUploads.status,
    })
    .from(schema.generatedImageArtifacts)
    .innerJoin(
      schema.files,
      and(
        eq(schema.files.workspaceId, schema.generatedImageArtifacts.workspaceId),
        eq(schema.files.id, schema.generatedImageArtifacts.artifactId),
      ),
    )
    .leftJoin(
      schema.fileUploads,
      eq(schema.fileUploads.id, schema.generatedImageArtifacts.uploadId),
    )
    .where(
      and(
        eq(schema.generatedImageArtifacts.workspaceId, workspaceId),
        eq(schema.generatedImageArtifacts.settlementKey, settlementKey),
      ),
    )
    .limit(1);
  return row ? mapGeneratedImageArtifact(row.artifact, row.file, row.uploadStatus) : null;
}

async function generatedImageArtifactByIdTx(
  tx: Database,
  workspaceId: string,
  artifactId: string,
): Promise<GeneratedImageArtifact | null> {
  const [row] = await tx
    .select({
      artifact: schema.generatedImageArtifacts,
      file: schema.files,
      uploadStatus: schema.fileUploads.status,
    })
    .from(schema.generatedImageArtifacts)
    .innerJoin(
      schema.files,
      and(
        eq(schema.files.workspaceId, schema.generatedImageArtifacts.workspaceId),
        eq(schema.files.id, schema.generatedImageArtifacts.artifactId),
      ),
    )
    .leftJoin(
      schema.fileUploads,
      eq(schema.fileUploads.id, schema.generatedImageArtifacts.uploadId),
    )
    .where(
      and(
        eq(schema.generatedImageArtifacts.workspaceId, workspaceId),
        eq(schema.generatedImageArtifacts.artifactId, artifactId),
      ),
    )
    .limit(1);
  return row ? mapGeneratedImageArtifact(row.artifact, row.file, row.uploadStatus) : null;
}

function mapGeneratedImageArtifact(
  artifact: typeof schema.generatedImageArtifacts.$inferSelect,
  file: typeof schema.files.$inferSelect,
  uploadStatus: string | null,
): GeneratedImageArtifact {
  return {
    ...artifact,
    sourceStrategy: artifact.sourceStrategy as GeneratedImageSourceStrategy,
    status: artifact.status as GeneratedImageArtifactStatus,
    uploadStatus: uploadStatus as FileUploadStatus | null,
    file: mapFile(file),
  };
}

function mapFile(row: typeof schema.files.$inferSelect): FileAsset {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as FileStatus,
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
}

function assertPreparedArtifactMatches(
  artifact: GeneratedImageArtifact,
  input: PrepareGeneratedImageArtifactInput,
): void {
  const adapterProvenanceMismatch =
    artifact.sourceStrategy === "provider_adapter" &&
    (artifact.sessionId !== input.sessionId ||
      artifact.turnId !== input.turnId ||
      artifact.toolCallId !== input.toolCallId);
  const mismatched =
    artifact.artifactId !== input.artifactId ||
    artifact.accountId !== input.accountId ||
    artifact.workspaceId !== input.workspaceId ||
    artifact.uploadId !== input.uploadId ||
    adapterProvenanceMismatch ||
    artifact.sourceStrategy !== input.sourceStrategy ||
    artifact.providerId !== input.providerId ||
    artifact.providerBindingHash !== input.providerBindingHash ||
    artifact.providerItemId !== input.providerItemId ||
    artifact.mediaType !== input.mediaType ||
    artifact.sizeBytes !== input.sizeBytes ||
    artifact.sha256 !== input.sha256 ||
    artifact.width !== input.width ||
    artifact.height !== input.height ||
    artifact.sandboxPath !== input.sandboxPath ||
    artifact.file.filename !== input.filename ||
    artifact.file.safeFilename !== input.safeFilename ||
    artifact.file.contentType !== input.mediaType ||
    artifact.file.sizeBytes !== input.sizeBytes ||
    artifact.file.sha256 !== input.sha256 ||
    artifact.file.bucket !== input.bucket ||
    artifact.file.objectKey !== input.objectKey;
  if (mismatched) {
    throw new Error("Generated image retry does not match the reserved immutable artifact");
  }
}

async function imageGenerationOperationByKeyTx(
  tx: Database,
  workspaceId: string,
  operationKey: string,
): Promise<ImageGenerationOperation | null> {
  const [row] = await tx
    .select()
    .from(schema.imageGenerationOperations)
    .where(
      and(
        eq(schema.imageGenerationOperations.workspaceId, workspaceId),
        eq(schema.imageGenerationOperations.operationKey, operationKey),
      ),
    )
    .limit(1);
  return row ? mapImageGenerationOperation(row) : null;
}

async function mutateImageGenerationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
  },
  mutate: (tx: Database, current: ImageGenerationOperation) => Promise<ImageGenerationOperation>,
): Promise<ImageGenerationOperation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.imageGenerationOperations)
          .where(
            and(
              eq(schema.imageGenerationOperations.workspaceId, input.workspaceId),
              eq(schema.imageGenerationOperations.id, input.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (!row || row.operationKey !== input.operationKey) {
          throw new Error("Image generation operation identity does not match");
        }
        return await mutate(tx, mapImageGenerationOperation(row));
      }),
  );
}

function mapImageGenerationOperation(
  row: typeof schema.imageGenerationOperations.$inferSelect,
): ImageGenerationOperation {
  return {
    ...row,
    status: row.status as ImageGenerationOperationStatus,
    creditState: row.creditState as ImageGenerationCreditState,
  };
}

function imageGenerationCreditFields(
  pricedCostMicros: number,
  creditUsageModelId: string | null,
): {
  pricedCostMicros: number;
  creditState: ImageGenerationCreditState;
  creditUsageModelId: string | null;
} {
  if (
    !Number.isSafeInteger(pricedCostMicros) ||
    pricedCostMicros < 0 ||
    pricedCostMicros > 1_000_000_000
  ) {
    throw new Error("Image generation credit price is outside the supported range");
  }
  if (creditUsageModelId !== null && !creditUsageModelId.trim()) {
    throw new Error("Image generation credit usage model is empty");
  }
  return {
    pricedCostMicros,
    creditState: pricedCostMicros > 0 ? "pending" : "not_applicable",
    creditUsageModelId: pricedCostMicros > 0 ? creditUsageModelId : null,
  };
}

/**
 * Allowance and spendable-balance admission like prepaid managed video, in the
 * same lock order as model settlement (account, then the ledger trigger's
 * workspace allowance fence). Plan and trial grants covering the turn's model
 * count, and images still in their provider request hold their price.
 */
async function admitImageGenerationCredits(
  tx: Database,
  operation: ImageGenerationOperation,
): Promise<void> {
  if (!operation.turnId) {
    throw new Error("Paid image initiating turn is unavailable");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.accountId}))`);
  const settledAt = await beginPlanCreditSettlement(tx, operation.accountId);
  const attribution = await creditDebitAttributionForTurn(tx, {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    turnId: operation.turnId,
  });
  const refusal = await checkWorkspaceAllowance(tx, {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    subjectId: attribution.kind === "turn" ? attribution.initiatingHumanSubjectId : null,
  });
  if (refusal) {
    throw new ImageGenerationCreditError(
      refusal.scope === "member"
        ? "your usage allowance in this workspace is used up"
        : "this workspace's usage allowance is used up",
      "allowance_exhausted",
    );
  }
  // Plan and trial grants covering the turn's model pay, as they do for chat.
  const { balanceMicros } = await getSpendableCreditBalance(
    tx,
    operation.accountId,
    operation.creditUsageModelId ?? undefined,
    undefined,
    settledAt,
  );
  const [held] = await rawRows<{ micros: string }>(
    tx,
    sql`
    select coalesce(sum(priced_cost_micros), 0)::text as micros
    from image_generation_operations
    where workspace_id = ${operation.workspaceId}
      and credit_state = 'pending' and status = 'provider_started'
      and provider_started_at > statement_timestamp() - ${IMAGE_GENERATION_CREDIT_HOLD_WINDOW}::interval
      and id <> ${operation.id}`,
  );
  const available = balanceMicros - Number(held?.micros ?? 0);
  if (!Number.isSafeInteger(available) || available < operation.pricedCostMicros) {
    throw new ImageGenerationCreditError();
  }
}

async function debitImageGenerationCredits(
  tx: Database,
  operation: ImageGenerationOperation,
): Promise<"debited"> {
  if (operation.pricedCostMicros <= 0) {
    throw new Error("Image generation credit debit has an invalid price");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operation.accountId}))`);
  const settledAt = await beginPlanCreditSettlement(tx, operation.accountId);
  // The monthly plan pays first, then grants covering the turn's model, then
  // general credit, exactly as a settled chat response.
  const allocations = operation.creditUsageModelId
    ? planPostUseCreditAllocations(
        await getBillingBalance(tx, operation.accountId, undefined, settledAt, true),
        operation.pricedCostMicros,
        operation.creditUsageModelId,
      )
    : [];
  const now = new Date();
  const inserted = await tx
    .insert(schema.creditLedgerEntries)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      type: "image_generation_debit",
      amountMicros: -operation.pricedCostMicros,
      sourceType: "image_generation_operation",
      sourceId: operation.id,
      idempotencyKey: `credit:image_generation_debit:${operation.id}`,
      metadata: {
        turnId: operation.turnId,
        modelId: operation.modelId,
        creditUsageModelId: operation.creditUsageModelId,
        providerId: operation.providerId,
        pricedCostMicros: operation.pricedCostMicros,
      },
      occurredAt: now,
      createdAt: sql`${settledAt}::timestamptz`,
    })
    .onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey })
    .returning({ id: schema.creditLedgerEntries.id });
  if (inserted.length !== 1) {
    throw new Error("Image generation credit debit already exists");
  }
  if (allocations.length) {
    await tx.insert(schema.creditDebitAllocations).values(
      allocations.map((allocation) => ({
        ...allocation,
        accountId: operation.accountId,
        debitEntryId: inserted[0]!.id,
      })),
    );
  }
  await tx
    .insert(schema.usageEvents)
    .values({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      eventType: "image_generation.cost",
      quantity: operation.pricedCostMicros,
      unit: "usd_micros",
      sourceResourceType: "image_generation_operation",
      sourceResourceId: operation.id,
      sessionId: operation.sessionId,
      turnId: operation.turnId,
      turnAttemptId: operation.attemptId,
      idempotencyKey: `usage:image_generation.cost:${operation.id}`,
      occurredAt: now,
    })
    .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey });
  return "debited";
}

function assertImageGenerationOperationStableFieldsMatch(
  operation: ImageGenerationOperation,
  input: PrepareImageGenerationOperationInput,
): void {
  if (
    operation.id !== input.id ||
    operation.accountId !== input.accountId ||
    operation.workspaceId !== input.workspaceId ||
    operation.sessionId !== input.sessionId ||
    operation.turnId !== input.turnId ||
    operation.operationKey !== input.operationKey ||
    operation.toolCallId !== input.toolCallId ||
    operation.providerId !== input.providerId ||
    operation.modelId !== input.modelId ||
    operation.requestDigest !== input.requestDigest
  ) {
    throw new Error("Image generation retry does not match the reserved operation");
  }
}
