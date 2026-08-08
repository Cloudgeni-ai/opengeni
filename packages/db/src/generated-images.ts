import type { FileAsset, FileStatus, FileUploadStatus } from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { withRlsContext, withWorkspaceRls } from "./database";
import * as schema from "./schema";

export type GeneratedImageSourceStrategy = "native_hosted" | "provider_adapter";
export type GeneratedImageArtifactStatus = "pending" | "ready";
export type ImageGenerationOperationStatus =
  | "prepared"
  | "provider_started"
  | "completed"
  | "outcome_unknown";

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
  "status" | "providerStartedAt" | "completedAt" | "lastError" | "createdAt" | "updatedAt"
>;

export async function prepareImageGenerationOperation(
  db: Database,
  input: PrepareImageGenerationOperationInput,
): Promise<{ operation: ImageGenerationOperation; created: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`image-generation-operation:${input.operationKey}`}, 0))`,
        );
        const existing = await imageGenerationOperationByKeyTx(
          tx,
          input.workspaceId,
          input.operationKey,
        );
        if (existing) {
          assertImageGenerationOperationMatches(existing, input);
          return { operation: existing, created: false };
        }
        const [row] = await tx
          .insert(schema.imageGenerationOperations)
          .values({ ...input, status: "prepared" })
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
  },
): Promise<{ operation: ImageGenerationOperation; started: boolean }> {
  let started = false;
  const operation = await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status !== "prepared") return current;
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

export async function completeImageGenerationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationKey: string;
  },
): Promise<ImageGenerationOperation> {
  return await mutateImageGenerationOperation(db, input, async (tx, current) => {
    if (current.status === "completed") return current;
    if (current.status !== "provider_started" && current.status !== "outcome_unknown") {
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
          eq(schema.generatedImageArtifacts.workspaceId, input.workspaceId),
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
    const now = new Date();
    const [row] = await tx
      .update(schema.imageGenerationOperations)
      .set({
        status: "completed",
        completedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(schema.imageGenerationOperations.id, current.id))
      .returning();
    if (!row) throw new Error("Failed to complete image generation operation");
    return mapImageGenerationOperation(row);
  });
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
        // `settlementKey` is the durable provider-operation identity. Serializing
        // only that key makes concurrent Temporal/activity retries converge
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

export async function settleGeneratedImageArtifactReady(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    artifactId: string;
    settlementKey: string;
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
        if (existing.status === "ready") return existing;
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
        return settled;
      }),
  );
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
  };
}

function assertImageGenerationOperationMatches(
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
    operation.providerBindingHash !== input.providerBindingHash ||
    operation.modelId !== input.modelId ||
    operation.requestDigest !== input.requestDigest ||
    operation.expectedArtifactId !== input.expectedArtifactId
  ) {
    throw new Error("Image generation retry does not match the reserved operation");
  }
}
