import { createHash } from "node:crypto";
import {
  BrowserDownload,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserDownloadSaveRequest as BrowserDownloadSaveRequestValue,
  type BrowserDownloadSaveResponse as BrowserDownloadSaveResponseValue,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type Database, withRlsContext, withWorkspaceRls } from "./database";
import {
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
} from "./browser-auth";
import * as schema from "./schema";

type OperationRow = typeof schema.interactionResourceOperations.$inferSelect;

type SaveMetadata = {
  browserSessionId: string;
  controllerGeneration: string;
  sourceSessionId: string;
  destinationPath: string;
  overwrite: boolean;
  fileId: string;
  uploadId: string;
  objectKey: string;
  safeFilename: string;
  contentType: string;
  download: BrowserDownloadValue;
};

export type BrowserDownloadSavePreparation = SaveMetadata & {
  operationId: string;
  state: OperationRow["state"];
  errorCode: string | null;
  replayed: boolean;
  dispatchedNow: boolean;
  response: BrowserDownloadSaveResponseValue | null;
};

type SaveIdentity = {
  accountId: string;
  workspaceId: string;
  actorSubjectId: string;
  browserSessionId: string;
  downloadId: string;
  request: BrowserDownloadSaveRequestValue;
};

export async function findBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSavePreparation | null> {
  const input = parseIdentity(inputValue);
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [operation] = await scopedDb
      .select()
      .from(schema.interactionResourceOperations)
      .where(
        and(
          eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
          eq(schema.interactionResourceOperations.operationId, input.request.operationId),
        ),
      )
      .limit(1);
    if (!operation) return null;
    return preparation(operation, input, true);
  });
}

export async function prepareBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity & {
    sourceSessionId: string;
    download: BrowserDownloadValue;
    fileId: string;
    safeFilename: string;
    contentType: string;
    bucket: string;
    objectKey: string;
    uploadExpiresAt: Date;
  },
): Promise<BrowserDownloadSavePreparation> {
  const input = parseIdentity(inputValue);
  const download = BrowserDownload.parse(inputValue.download);
  if (
    download.id !== input.downloadId ||
    download.browserSessionId !== input.browserSessionId ||
    download.status !== "completed" ||
    !download.sha256
  ) {
    throw new InteractionResourceStateError("Browser download is not ready to save");
  }
  const sourceSessionId = requireUuid(inputValue.sourceSessionId, "sourceSessionId");
  const fileId = requireUuid(inputValue.fileId, "fileId");
  const safeFilename = requireBoundedString(inputValue.safeFilename, "safeFilename", 4_096);
  const contentType = requireBoundedString(inputValue.contentType, "contentType", 512);
  const bucket = requireBoundedString(inputValue.bucket, "bucket", 1_024);
  const objectKey = requireBoundedString(inputValue.objectKey, "objectKey", 2_048);
  const expectedObjectKey = `workspaces/${input.workspaceId}/files/${fileId}/original/${safeFilename}`;
  if (objectKey !== expectedObjectKey) {
    throw new InteractionResourceConflictError("Browser download object key is not canonical");
  }
  if (!Number.isFinite(inputValue.uploadExpiresAt.valueOf())) {
    throw new InteractionResourceStateError("Browser download upload expiry is invalid");
  }

  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const [existing] = await tx
          .select()
          .from(schema.interactionResourceOperations)
          .where(
            and(
              eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
              eq(schema.interactionResourceOperations.operationId, input.request.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          const replay = preparation(existing, input, true);
          if (replay.state === "prepared" || replay.state === "dispatched") {
            await tx
              .update(schema.fileUploads)
              .set({ expiresAt: inputValue.uploadExpiresAt, updatedAt: sql`now()` })
              .where(
                and(
                  eq(schema.fileUploads.workspaceId, input.workspaceId),
                  eq(schema.fileUploads.id, replay.uploadId),
                  eq(schema.fileUploads.status, "pending"),
                ),
              );
          }
          return { ...replay, dispatchedNow: false };
        }

        const [session] = await tx
          .select({
            lifecycle: schema.browserSessions.lifecycle,
            controllerGeneration: schema.browserSessions.controllerGeneration,
          })
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.accountId, input.accountId),
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .limit(1);
        if (!session) throw new InteractionResourceNotFoundError("BrowserSession not found");
        if (
          session.lifecycle !== "active" ||
          session.controllerGeneration !== download.controllerGeneration
        ) {
          throw new InteractionResourceStateError(
            "Browser download controller is no longer active",
          );
        }
        const [association] = await tx
          .select({ id: schema.browserSessionAssociations.id })
          .from(schema.browserSessionAssociations)
          .where(
            and(
              eq(schema.browserSessionAssociations.workspaceId, input.workspaceId),
              eq(schema.browserSessionAssociations.browserSessionId, input.browserSessionId),
              eq(schema.browserSessionAssociations.sessionId, sourceSessionId),
              eq(schema.browserSessionAssociations.relationship, "created"),
            ),
          )
          .limit(1);
        if (!association) {
          throw new InteractionResourceConflictError(
            "Browser download source session lost its creation binding",
          );
        }

        await tx.insert(schema.files).values({
          id: fileId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          status: "pending_upload",
          filename: download.filename,
          safeFilename,
          contentType,
          sizeBytes: download.receivedBytes,
          sha256: download.sha256,
          bucket,
          objectKey,
        });
        const [upload] = await tx
          .insert(schema.fileUploads)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            fileId,
            status: "pending",
            expiresAt: inputValue.uploadExpiresAt,
          })
          .returning({ id: schema.fileUploads.id });
        if (!upload) throw new Error("Browser download upload insert returned no row");
        const metadata: SaveMetadata = {
          browserSessionId: input.browserSessionId,
          controllerGeneration: download.controllerGeneration,
          sourceSessionId,
          destinationPath: input.request.destinationPath,
          overwrite: input.request.overwrite,
          fileId,
          uploadId: upload.id,
          objectKey,
          safeFilename,
          contentType,
          download,
        };
        const [operation] = await tx
          .insert(schema.interactionResourceOperations)
          .values({
            operationId: input.request.operationId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            resourceKind: "browser_download",
            resourceId: input.downloadId,
            kind: "save",
            requestDigest: requestDigest(input),
            metadata,
            state: "prepared",
            actorSubjectId: input.actorSubjectId,
          })
          .returning();
        if (!operation) throw new Error("Browser download save insert returned no row");
        return { ...preparation(operation, input, false), dispatchedNow: false };
      }),
  );
}

export async function dispatchBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSavePreparation> {
  const input = parseIdentity(inputValue);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
        const current = preparation(operation, input, true);
        if (current.state === "prepared") {
          const [updated] = await tx
            .update(schema.interactionResourceOperations)
            .set({ state: "dispatched" })
            .where(
              and(
                eq(schema.interactionResourceOperations.operationId, input.request.operationId),
                eq(schema.interactionResourceOperations.state, "prepared"),
              ),
            )
            .returning();
          if (!updated) throw new InteractionResourceConflictError("Save dispatch lost its fence");
          return { ...preparation(updated, input, current.replayed), dispatchedNow: true };
        }
        return { ...current, dispatchedNow: false };
      }),
  );
}

export async function completeBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSaveResponseValue> {
  const input = parseIdentity(inputValue);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
        const current = preparation(operation, input, true);
        if (current.response) return { ...current.response, replayed: true };
        if (current.state !== "dispatched") {
          throw terminalStateError(current);
        }
        const response = BrowserDownloadSaveResponse.parse({
          download: current.download,
          destinationPath: current.destinationPath,
          fileId: current.fileId,
          operationId: input.request.operationId,
          replayed: false,
        });
        const [completed] = await tx
          .update(schema.interactionResourceOperations)
          .set({
            state: "completed",
            resultVersion: current.download.version,
            result: response,
            settledAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.interactionResourceOperations.operationId, input.request.operationId),
              eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
              eq(schema.interactionResourceOperations.state, "dispatched"),
            ),
          )
          .returning({ operationId: schema.interactionResourceOperations.operationId });
        if (!completed)
          throw new InteractionResourceConflictError("Save completion lost its fence");
        return response;
      }),
  );
}

export async function settleBrowserDownloadSaveFailure(
  db: Database,
  inputValue: SaveIdentity & {
    state: "failed" | "outcome_unknown";
    errorCode: string;
  },
): Promise<void> {
  const input = parseIdentity(inputValue);
  const errorCode = requireBoundedString(inputValue.errorCode, "errorCode", 512);
  await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.transaction(async (tx) => {
      await lockOperation(tx, input.request.operationId);
      const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
      const current = preparation(operation, input, true);
      if (
        current.state === "completed" ||
        current.state === "failed" ||
        current.state === "outcome_unknown"
      ) {
        return;
      }
      const [settled] = await tx
        .update(schema.interactionResourceOperations)
        .set({ state: inputValue.state, errorCode, settledAt: sql`now()` })
        .where(
          and(
            eq(schema.interactionResourceOperations.operationId, input.request.operationId),
            eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
            sql`${schema.interactionResourceOperations.state} in ('prepared', 'dispatched')`,
          ),
        )
        .returning({ operationId: schema.interactionResourceOperations.operationId });
      if (!settled) throw new InteractionResourceConflictError("Save failure lost its fence");
    });
  });
}

function parseIdentity(input: SaveIdentity): SaveIdentity {
  const request = BrowserDownloadSaveRequest.parse(input.request);
  return {
    accountId: requireUuid(input.accountId, "accountId"),
    workspaceId: requireUuid(input.workspaceId, "workspaceId"),
    actorSubjectId: requireBoundedString(input.actorSubjectId, "actorSubjectId", 1_024),
    browserSessionId: requireUuid(input.browserSessionId, "browserSessionId"),
    downloadId: requireUuid(input.downloadId, "downloadId"),
    request,
  };
}

function requestDigest(input: SaveIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        browserSessionId: input.browserSessionId,
        destinationPath: input.request.destinationPath,
        downloadId: input.downloadId,
        overwrite: input.request.overwrite,
      }),
    )
    .digest("hex");
}

function preparation(
  operation: OperationRow,
  input: SaveIdentity,
  replayed: boolean,
): BrowserDownloadSavePreparation {
  if (
    operation.accountId !== input.accountId ||
    operation.workspaceId !== input.workspaceId ||
    operation.resourceKind !== "browser_download" ||
    operation.resourceId !== input.downloadId ||
    operation.kind !== "save" ||
    operation.requestDigest !== requestDigest(input) ||
    operation.actorSubjectId !== input.actorSubjectId
  ) {
    throw new InteractionResourceConflictError(
      "Operation id is already bound to another browser download save",
    );
  }
  const metadata = saveMetadata(operation.metadata);
  if (
    metadata.browserSessionId !== input.browserSessionId ||
    metadata.download.id !== input.downloadId
  ) {
    throw new InteractionResourceConflictError("Browser download save metadata lost its binding");
  }
  let response: BrowserDownloadSaveResponseValue | null = null;
  if (operation.state === "completed") {
    response = BrowserDownloadSaveResponse.parse(operation.result);
    if (
      response.operationId !== operation.operationId ||
      response.download.id !== input.downloadId ||
      response.fileId !== metadata.fileId ||
      response.destinationPath !== metadata.destinationPath
    ) {
      throw new InteractionResourceStateError("Browser download save result is corrupted");
    }
    response = { ...response, replayed: true };
  }
  return {
    ...metadata,
    operationId: operation.operationId,
    state: operation.state,
    errorCode: operation.errorCode,
    replayed,
    dispatchedNow: false,
    response,
  };
}

function saveMetadata(value: unknown): SaveMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionResourceStateError("Browser download save metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    browserSessionId: requireUuid(record.browserSessionId, "metadata.browserSessionId"),
    controllerGeneration: requireBoundedString(
      record.controllerGeneration,
      "metadata.controllerGeneration",
      256,
    ),
    sourceSessionId: requireUuid(record.sourceSessionId, "metadata.sourceSessionId"),
    destinationPath: BrowserDownloadSaveRequest.shape.destinationPath.parse(record.destinationPath),
    overwrite: requireBoolean(record.overwrite, "metadata.overwrite"),
    fileId: requireUuid(record.fileId, "metadata.fileId"),
    uploadId: requireUuid(record.uploadId, "metadata.uploadId"),
    objectKey: requireBoundedString(record.objectKey, "metadata.objectKey", 2_048),
    safeFilename: requireBoundedString(record.safeFilename, "metadata.safeFilename", 4_096),
    contentType: requireBoundedString(record.contentType, "metadata.contentType", 512),
    download: BrowserDownload.parse(record.download),
  };
}

async function lockOperation(db: Database, operationId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`browser-download-save:${operationId}`}, 0))`,
  );
}

async function requireOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow> {
  const [operation] = await db
    .select()
    .from(schema.interactionResourceOperations)
    .where(
      and(
        eq(schema.interactionResourceOperations.workspaceId, workspaceId),
        eq(schema.interactionResourceOperations.operationId, operationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!operation) throw new InteractionResourceNotFoundError("Browser download save not found");
  return operation;
}

function terminalStateError(
  prepared: BrowserDownloadSavePreparation,
): InteractionResourceStateError {
  return new InteractionResourceStateError(
    `Browser download save is ${prepared.state.replace("_", " ")}${prepared.errorCode ? ` (${prepared.errorCode})` : ""}`,
  );
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new InteractionResourceStateError(`${label} is invalid`);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InteractionResourceStateError(`${label} is invalid`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new InteractionResourceStateError(`${label} is invalid`);
  return value;
}
